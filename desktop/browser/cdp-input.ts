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
