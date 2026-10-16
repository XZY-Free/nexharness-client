/**
 * CDP 输入原语：按键代码映射与 console level 归一。
 *
 * 纯函数集合，不依赖 electron，便于单测。由 BrowserController 的
 * 键盘输入与 console 事件缓冲路径调用。
 */

/** CDP 按键代码映射结果。 */
export interface CdpKeyCode {
  key: string;
  code: string;
  keyCode: number;
}

/**
 * 将按键名转换为 CDP 按键代码。
 *
 * 支持常见特殊键（Enter、Tab、Escape 等）和单字符键。
 * 对于未识别的多字符键名，按原样传入（CDP 可能识别）。
 */
export function toCdpKeyCode(key: string): CdpKeyCode {
  const specialKeys: Record<string, CdpKeyCode> = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    Space: { key: " ", code: "Space", keyCode: 32 },
  };
  const special = specialKeys[key];
  if (special) {
    return special;
  }
  // 空格键（" "）
  if (key === " ") {
    return { key: " ", code: "Space", keyCode: 32 };
  }
  // 单字符键
  if (key.length === 1) {
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      keyCode: upper.charCodeAt(0),
    };
  }
  // 未识别的多字符键名，按原样传入
  return { key, code: key, keyCode: 0 };
}

/**
 * 将 CDP Runtime.consoleAPICalled 的 type 映射为 ConsoleEntry level。
 *
 * CDP type 值：log / warning / error / info / debug / verbose
 * 映射后与 redaction 模块 ConsoleEntry.level 对齐。
 */
export function mapConsoleType(type: string | undefined): "error" | "warning" | "log" | "info" {
  switch (type) {
    case "error":
      return "error";
    case "warning":
    case "warn":
      return "warning";
    case "info":
      return "info";
    case "debug":
    case "verbose":
      return "log";
    default:
      return "log";
  }
}

// ─── CDP DOM 节点解析（file input 上传用）────────────────────────────

/** CDP sendCommand 的最小结果形状。 */
export interface CdpCommandResult {
  readonly ok: boolean;
  readonly result?: unknown;
}

/**
 * 从 `DOM.getDocument` 结果中提取 document rootId。
 *
 * fail-closed：ok=false / result 缺失 / root 缺失 / nodeId 为 0（CDP 约定 0 表示无效）
 * 一律返回 null，调用方据此放弃操作（**不猜测**、不重试）。
 */
export function extractDocumentRootId(result: CdpCommandResult): number | null {
  if (!result.ok || !result.result) return null;
  const root = (result.result as { root?: { nodeId?: unknown } }).root;
  const nodeId = root?.nodeId;
  if (typeof nodeId !== "number" || nodeId === 0) return null;
  return nodeId;
}

/**
 * 从 `DOM.querySelector` 结果中提取匹配节点 nodeId。
 *
 * fail-closed：ok=false / result 缺失 / nodeId 缺失或为 0 → null。
 * nodeId=0 是 CDP「未找到匹配」的约定，必须当作失败而非有效节点。
 */
export function extractQueryNodeId(result: CdpCommandResult): number | null {
  if (!result.ok || !result.result) return null;
  const nodeId = (result.result as { nodeId?: unknown }).nodeId;
  if (typeof nodeId !== "number" || nodeId === 0) return null;
  return nodeId;
}
