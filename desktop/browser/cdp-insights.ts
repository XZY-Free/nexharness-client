/**
 * CDP 事件归一（纯函数）。
 *
 * 把 debugger 收到的原始 CDP 事件（Runtime.consoleAPICalled / exceptionThrown、
 * Network.*）解析成 PageInsightsStore 的入参形状。不含 electron / CDP 依赖，
 * 便于单测；由 BrowserController.handleCdpEvent 调用。
 */

import type { ConsoleEntry } from "../../lib/desktop/redaction";
import { mapConsoleType } from "./cdp-input";

/**
 * Console 条目事件的归一结果。
 * `text` 为空且无可判定内容时返回 null（调用方跳过写入）。
 */
export interface ConsoleInsight {
  entry: ConsoleEntry;
}

/** Network 事件的归一结果，按 kind 分派到 Store 的对应方法。 */
export type NetworkInsight =
  | {
      kind: "request";
      requestId: string;
      params: { url: string; method: string; headers?: Record<string, string>; timestamp: number };
    }
  | {
      kind: "response";
      requestId: string;
      params: {
        status: number;
        statusText?: string;
        mimeType?: string;
        headers?: Record<string, string>;
      };
    }
  | {
      kind: "finished";
      requestId: string;
      params: { timestamp: number; encodedDataLength?: number };
    }
  | {
      kind: "failed";
      requestId: string;
      params: { timestamp: number; errorText?: string; blockedReason?: string };
    };

/** CDP 事件归一后的动作。 */
export type CdpInsight =
  | { type: "console"; insight: ConsoleInsight }
  | { type: "network"; insight: NetworkInsight }
  | { type: "ignore" };

function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

/** 把 CDP consoleAPICalled 的 args 拼成一行文本。 */
function consoleTextFromArgs(args: Array<{ value?: string; description?: string }>): string {
  return args.map((a) => a.value ?? a.description ?? "").join(" ");
}

/**
 * 将一条 CDP 事件归一为 Store 动作。
 *
 * 未识别的方法、以及缺 requestId 的 Network 事件一律返回 `ignore`
 * （静默跳过，不抛错——CDP 事件流不应因未知方法中断）。
 */
export function normalizeCdpEvent(method: string, params: unknown): CdpInsight {
  const p = asRecord(params);

  switch (method) {
    case "Runtime.consoleAPICalled": {
      const args = (p.args as Array<{ value?: string; description?: string }>) ?? [];
      const stackTrace = p.stackTrace as
        | { callFrames?: Array<{ url?: string; lineNumber?: number }> }
        | undefined;
      const frame = stackTrace?.callFrames?.[0];
      return {
        type: "console",
        insight: {
          entry: {
            level: mapConsoleType(p.type as string | undefined),
            text: consoleTextFromArgs(args),
            url: frame?.url,
            lineNumber: frame?.lineNumber,
          },
        },
      };
    }

    case "Runtime.exceptionThrown": {
      const details = asRecord(p.exceptionDetails) as {
        exception?: { description?: string };
        text?: string;
        url?: string;
        lineNumber?: number;
      };
      return {
        type: "console",
        insight: {
          entry: {
            level: "pageerror",
            text: details.exception?.description ?? details.text ?? "Uncaught exception",
            url: details.url,
            lineNumber: details.lineNumber,
          },
        },
      };
    }

    case "Network.requestWillBeSent": {
      const requestId = p.requestId as string | undefined;
      if (!requestId) return { type: "ignore" };
      const request = asRecord(p.request) as {
        url?: string;
        method?: string;
        headers?: Record<string, string>;
      };
      return {
        type: "network",
        insight: {
          kind: "request",
          requestId,
          params: {
            url: request.url ?? "",
            method: request.method ?? "GET",
            headers: request.headers,
            timestamp: (p.timestamp as number) ?? Date.now() / 1000,
          },
        },
      };
    }

    case "Network.responseReceived": {
      const requestId = p.requestId as string | undefined;
      if (!requestId) return { type: "ignore" };
      const response = asRecord(p.response) as {
        status?: number;
        statusText?: string;
        mimeType?: string;
        headers?: Record<string, string>;
      };
      return {
        type: "network",
        insight: {
          kind: "response",
          requestId,
          params: {
            status: response.status ?? 0,
            statusText: response.statusText,
            mimeType: response.mimeType,
            headers: response.headers,
          },
        },
      };
    }

    case "Network.loadingFinished": {
      const requestId = p.requestId as string | undefined;
      if (!requestId) return { type: "ignore" };
      return {
        type: "network",
        insight: {
          kind: "finished",
          requestId,
          params: {
            timestamp: (p.timestamp as number) ?? Date.now() / 1000,
            encodedDataLength: p.encodedDataLength as number | undefined,
          },
        },
      };
    }

    case "Network.loadingFailed": {
      const requestId = p.requestId as string | undefined;
      if (!requestId) return { type: "ignore" };
      return {
        type: "network",
        insight: {
          kind: "failed",
          requestId,
          params: {
            timestamp: (p.timestamp as number) ?? Date.now() / 1000,
            errorText: p.errorText as string | undefined,
            blockedReason: p.blockedReason as string | undefined,
          },
        },
      };
    }

    default:
      return { type: "ignore" };
  }
}

// ─── CDP 事件分发（从 browser-controller 抽出）──────────────────────

/** 洞察写入目标（PageInsightsStore 的方法子集）。 */
export interface InsightsSink {
  addConsoleEntry(threadId: string, tabId: string, entry: unknown): void;
  bufferNetworkRequest(threadId: string, tabId: string, requestId: string, params: unknown): void;
  bufferNetworkResponse(threadId: string, tabId: string, requestId: string, params: unknown): void;
  finalizeNetworkEntry(threadId: string, tabId: string, requestId: string, params: unknown): void;
  failNetworkEntry(threadId: string, tabId: string, requestId: string, params: unknown): void;
}

/**
 * 把一条原始 CDP 事件分发到 insights sink。
 *
 * 抽出价值：原 handleCdpEvent 是"归一 + switch 分发"，属**纯路由**（无 Electron 依赖）。
 * 现在可单测"哪种事件落到哪个方法"，且 ignore 语义（未知方法静默跳过、不抛）
 * 由测试固化。
 *
 * @returns 是否被处理（false = ignore）
 */
export function dispatchCdpInsight(
  method: string,
  params: unknown,
  threadId: string,
  tabId: string,
  sink: InsightsSink,
): boolean {
  const insight = normalizeCdpEvent(method, params);
  if (insight.type === "ignore") return false;

  if (insight.type === "console") {
    sink.addConsoleEntry(threadId, tabId, insight.insight.entry);
    return true;
  }

  const net = insight.insight;
  switch (net.kind) {
    case "request":
      sink.bufferNetworkRequest(threadId, tabId, net.requestId, net.params);
      break;
    case "response":
      sink.bufferNetworkResponse(threadId, tabId, net.requestId, net.params);
      break;
    case "finished":
      sink.finalizeNetworkEntry(threadId, tabId, net.requestId, net.params);
      break;
    case "failed":
      sink.failNetworkEntry(threadId, tabId, net.requestId, net.params);
      break;
  }
  return true;
}
