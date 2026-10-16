import { describe, expect, it } from "vitest";
import { dispatchCdpInsight, normalizeCdpEvent } from "./cdp-insights";

/**
 * normalizeCdpEvent 把原始 CDP 事件归一为 Store 动作。
 * 这些用例锁定：事件形状解析、缺字段兜底、未知方法静默忽略（不中断事件流）。
 */
describe("normalizeCdpEvent — Console", () => {
  it("consoleAPICalled 归一 level/text/位置", () => {
    const r = normalizeCdpEvent("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ value: "boom" }, { description: "Object" }],
      stackTrace: { callFrames: [{ url: "https://x/a.js", lineNumber: 42 }] },
    });
    expect(r.type).toBe("console");
    if (r.type === "console") {
      expect(r.insight.entry.level).toBe("error");
      expect(r.insight.entry.text).toBe("boom Object");
      expect(r.insight.entry.url).toBe("https://x/a.js");
      expect(r.insight.entry.lineNumber).toBe(42);
    }
  });

  it("consoleAPICalled 缺 args/stackTrace 时兜底为空", () => {
    const r = normalizeCdpEvent("Runtime.consoleAPICalled", { type: "log" });
    expect(r.type).toBe("console");
    if (r.type === "console") {
      expect(r.insight.entry.text).toBe("");
      expect(r.insight.entry.url).toBeUndefined();
      expect(r.insight.entry.level).toBe("log");
    }
  });

  it("exceptionThrown 固定为 pageerror 级别", () => {
    const r = normalizeCdpEvent("Runtime.exceptionThrown", {
      exceptionDetails: { exception: { description: "TypeError: x is not a function" } },
    });
    expect(r.type).toBe("console");
    if (r.type === "console") {
      expect(r.insight.entry.level).toBe("pageerror");
      expect(r.insight.entry.text).toBe("TypeError: x is not a function");
    }
  });

  it("exceptionThrown 无 exception.description 时回退 text，再回退默认文案", () => {
    const a = normalizeCdpEvent("Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught at eval" },
    });
    const b = normalizeCdpEvent("Runtime.exceptionThrown", {});
    if (a.type === "console") expect(a.insight.entry.text).toBe("Uncaught at eval");
    if (b.type === "console") expect(b.insight.entry.text).toBe("Uncaught exception");
  });
});

describe("normalizeCdpEvent — Network", () => {
  it("requestWillBeSent 归一 url/method/timestamp", () => {
    const r = normalizeCdpEvent("Network.requestWillBeSent", {
      requestId: "r1",
      request: { url: "https://x/api", method: "POST", headers: { a: "1" } },
      timestamp: 1234.5,
    });
    expect(r.type).toBe("network");
    if (r.type === "network" && r.insight.kind === "request") {
      expect(r.insight.requestId).toBe("r1");
      expect(r.insight.params.url).toBe("https://x/api");
      expect(r.insight.params.method).toBe("POST");
      expect(r.insight.params.timestamp).toBe(1234.5);
    }
  });

  it("requestWillBeSent 缺 url/method 时兜底为 '' / GET", () => {
    const r = normalizeCdpEvent("Network.requestWillBeSent", { requestId: "r1" });
    if (r.type === "network" && r.insight.kind === "request") {
      expect(r.insight.params.url).toBe("");
      expect(r.insight.params.method).toBe("GET");
    }
  });

  it("responseReceived 归一状态与响应头", () => {
    const r = normalizeCdpEvent("Network.responseReceived", {
      requestId: "r1",
      response: { status: 404, statusText: "Not Found", mimeType: "text/html" },
    });
    if (r.type === "network" && r.insight.kind === "response") {
      expect(r.insight.params.status).toBe(404);
      expect(r.insight.params.mimeType).toBe("text/html");
    }
  });

  it("responseReceived 缺 status 时兜底为 0（而非 undefined）", () => {
    const r = normalizeCdpEvent("Network.responseReceived", { requestId: "r1" });
    if (r.type === "network" && r.insight.kind === "response") {
      expect(r.insight.params.status).toBe(0);
    }
  });

  it("loadingFinished 归一 encodedDataLength", () => {
    const r = normalizeCdpEvent("Network.loadingFinished", {
      requestId: "r1",
      timestamp: 99,
      encodedDataLength: 2048,
    });
    if (r.type === "network" && r.insight.kind === "finished") {
      expect(r.insight.params.timestamp).toBe(99);
      expect(r.insight.params.encodedDataLength).toBe(2048);
    }
  });

  it("loadingFailed 归一 errorText / blockedReason", () => {
    const a = normalizeCdpEvent("Network.loadingFailed", {
      requestId: "r1",
      errorText: "ECONNRESET",
    });
    const b = normalizeCdpEvent("Network.loadingFailed", {
      requestId: "r2",
      blockedReason: "CORS",
    });
    if (a.type === "network" && a.insight.kind === "failed")
      expect(a.insight.params.errorText).toBe("ECONNRESET");
    if (b.type === "network" && b.insight.kind === "failed")
      expect(b.insight.params.blockedReason).toBe("CORS");
  });

  it("缺 requestId 的 Network 事件一律 ignore（不污染缓冲）", () => {
    for (const m of [
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Network.loadingFinished",
      "Network.loadingFailed",
    ]) {
      expect(normalizeCdpEvent(m, {}).type).toBe("ignore");
      expect(normalizeCdpEvent(m, { requestId: "" }).type).toBe("ignore");
    }
  });
});

describe("normalizeCdpEvent — 健壮性", () => {
  it("未知方法静默 ignore（CDP 事件流不因未知方法中断）", () => {
    expect(normalizeCdpEvent("Page.frameNavigated", {}).type).toBe("ignore");
    expect(normalizeCdpEvent("", {}).type).toBe("ignore");
  });

  it("params 为 null / undefined 不抛错", () => {
    expect(() => normalizeCdpEvent("Runtime.consoleAPICalled", null)).not.toThrow();
    expect(() => normalizeCdpEvent("Runtime.consoleAPICalled", undefined)).not.toThrow();
    expect(normalizeCdpEvent("Runtime.exceptionThrown", null).type).toBe("console");
  });
});

describe("dispatchCdpInsight — 事件路由", () => {
  function fakeSink() {
    const log = [];
    return {
      log,
      addConsoleEntry: (t, tab, entry) => log.push(`console:${t}:${tab}`),
      bufferNetworkRequest: (t, tab, id) => log.push(`req:${id}`),
      bufferNetworkResponse: (t, tab, id) => log.push(`res:${id}`),
      finalizeNetworkEntry: (t, tab, id) => log.push(`fin:${id}`),
      failNetworkEntry: (t, tab, id) => log.push(`fail:${id}`),
    };
  }

  it("未知方法 → 不写任何 sink 且返回 false（静默跳过）", () => {
    const sink = fakeSink();
    expect(dispatchCdpInsight("Unknown.method", {}, "t", "tab", sink)).toBe(false);
    expect(sink.log).toEqual([]);
  });

  it("consoleAPICalled → addConsoleEntry", () => {
    const sink = fakeSink();
    const ok = dispatchCdpInsight(
      "Runtime.consoleAPICalled",
      { type: "log", args: [{ value: "hi" }], stackTrace: { callFrames: [] } },
      "t1",
      "tab1",
      sink,
    );
    expect(ok).toBe(true);
    expect(sink.log).toEqual(["console:t1:tab1"]);
  });

  it("缺 requestId 的 Network 事件 → ignore（不写 sink）", () => {
    const sink = fakeSink();
    expect(dispatchCdpInsight("Network.requestWillBeSent", { request: {} }, "t", "tab", sink)).toBe(
      false,
    );
    expect(sink.log).toEqual([]);
  });

  it("Network.requestWillBeSent（含 requestId）→ bufferNetworkRequest", () => {
    const sink = fakeSink();
    dispatchCdpInsight(
      "Network.requestWillBeSent",
      { requestId: "r1", request: { url: "https://x", method: "GET" } },
      "t",
      "tab",
      sink,
    );
    expect(sink.log).toEqual(["req:r1"]);
  });

  it("Network.responseReceived → bufferNetworkResponse", () => {
    const sink = fakeSink();
    dispatchCdpInsight(
      "Network.responseReceived",
      { requestId: "r2", response: { status: 200 } },
      "t",
      "tab",
      sink,
    );
    expect(sink.log).toEqual(["res:r2"]);
  });

  it("Network.loadingFinished → finalizeNetworkEntry", () => {
    const sink = fakeSink();
    dispatchCdpInsight("Network.loadingFinished", { requestId: "r3" }, "t", "tab", sink);
    expect(sink.log).toEqual(["fin:r3"]);
  });

  it("Network.loadingFailed → failNetworkEntry", () => {
    const sink = fakeSink();
    dispatchCdpInsight("Network.loadingFailed", { requestId: "r4" }, "t", "tab", sink);
    expect(sink.log).toEqual(["fail:r4"]);
  });

  it("ignore 事件不抛错（CDP 流不应因未知方法中断）", () => {
    const sink = fakeSink();
    expect(() =>
      dispatchCdpInsight("Page.frameNavigated", { frame: {} }, "t", "tab", sink),
    ).not.toThrow();
  });
});
