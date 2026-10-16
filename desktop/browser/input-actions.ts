/**
 * CDP 输入动作（从 browser-controller 抽出，原约 150 行）。
 *
 * 抽出价值：
 * 1. **消除重复的 acquire→sendCommand→release 骨架**（click/press/scroll/type 各写一遍）
 * 2. `buildSelectScript` 是**安全相关**的 —— select 用 executeJavaScript 注入脚本，
 *    必须靠 JSON.stringify 防注入（否则页面/用户可控的 selector/value 可逃逸成代码）
 * 3. 只依赖 InputTargetLike 接口 → 可用替身单测（覆盖 CDP 失败分支、按钮白名单等）
 *
 * 注意：acquire/release 由调用方（controller）负责，本模块只管"命令序列"。
 */

/** CDP 命令目标的最小接口。 */
export interface InputTargetLike {
  sendCommand(method: string, params: unknown): Promise<{ ok: boolean }>;
}

/** 鼠标按钮白名单（非法值一律回落 left）。 */
export const MOUSE_BUTTONS = ["left", "right", "middle"] as const;
export type MouseButton = (typeof MOUSE_BUTTONS)[number];

/** 归一鼠标按钮：仅接受白名单内值，其余回落 left。 */
export function normalizeMouseButton(button: string | undefined): MouseButton {
  return button === "right" || button === "middle" ? button : "left";
}

/** 点击（pressed + released）。任一命令失败即 false（不发送 release）。 */
export async function dispatchClick(
  target: InputTargetLike,
  x: number,
  y: number,
  button?: string,
): Promise<boolean> {
  const validButton = normalizeMouseButton(button);
  const press = await target.sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: validButton,
    clickCount: 1,
  });
  if (!press.ok) return false;
  const release = await target.sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: validButton,
    clickCount: 1,
  });
  return release.ok;
}

/** 双击（两次 click；第一次失败即止）。 */
export async function dispatchDoubleClick(
  target: InputTargetLike,
  x: number,
  y: number,
): Promise<boolean> {
  const ok1 = await dispatchClick(target, x, y, "left");
  if (!ok1) return false;
  return dispatchClick(target, x, y, "left");
}

/** 按键（keyDown + keyUp）。 */
export async function dispatchPress(
  target: InputTargetLike,
  keyCode: { key: string; code: string; keyCode: number },
): Promise<boolean> {
  const down = await target.sendCommand("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: keyCode.key,
    code: keyCode.code,
    windowsVirtualKeyCode: keyCode.keyCode,
  });
  if (!down.ok) return false;
  const up = await target.sendCommand("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: keyCode.key,
    code: keyCode.code,
    windowsVirtualKeyCode: keyCode.keyCode,
  });
  return up.ok;
}

/** 输入文本。 */
export async function dispatchInsertText(target: InputTargetLike, text: string): Promise<boolean> {
  const result = await target.sendCommand("Input.insertText", { text });
  return result.ok;
}

/** 滚动（mouseWheel）。 */
export async function dispatchScroll(
  target: InputTargetLike,
  deltaX: number,
  deltaY: number,
): Promise<boolean> {
  const result = await target.sendCommand("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 0,
    y: 0,
    deltaX,
    deltaY,
  });
  return result.ok;
}

/**
 * 构造 select 元素赋值脚本（**注入安全关键**）。
 *
 * 用 `JSON.stringify` 把 selector/value/label 编码为 JS 字面量，避免：
 * - selector 含引号/反引号时逃逸出 `document.querySelector(...)` 上下文
 * - value 含 `"; alert(1); //` 之类的注入串
 *
 * 同时：仅当元素确为 `<select>` 才赋值（`tagName !== 'SELECT'` 直接返回 false），
 * 并派发 bubbling 的 change 事件，使 React 等受控组件能感知。
 */
export function buildSelectScript(params: {
  readonly selector: string;
  readonly value?: string;
  readonly label?: string;
}): string {
  const setByValue =
    params.value !== undefined ? `el.value = ${JSON.stringify(params.value)};` : "";
  const setByLabel =
    params.label !== undefined
      ? `for (const opt of el.options) { if (opt.text === ${JSON.stringify(params.label)}) { el.value = opt.value; break; } }`
      : "";
  return `(function() {
      const el = document.querySelector(${JSON.stringify(params.selector)});
      if (!el || el.tagName !== 'SELECT') return false;
      ${setByValue}
      ${setByLabel}
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
}
