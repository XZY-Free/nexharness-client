import { describe, expect, it, vi } from "vitest";
import {
  type InputTargetLike,
  buildSelectScript,
  dispatchClick,
  dispatchDoubleClick,
  dispatchInsertText,
  dispatchPress,
  dispatchScroll,
  normalizeMouseButton,
} from "./input-actions";

/**
 * CDP 输入动作。用替身测试（无需真实 Electron），覆盖：
 * 命令序列、失败短路、按钮白名单、以及 **select 脚本的注入防护**（安全关键）。
 */
function fakeTarget(okSequence: boolean[] = []) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let i = 0;
  const target: InputTargetLike = {
    sendCommand: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      const ok = okSequence[i] ?? true;
      i += 1;
      return { ok };
    }),
  };
  return { target, calls };
}

describe("normalizeMouseButton — 白名单", () => {
  it("left/right/middle 原样保留", () => {
    expect(normalizeMouseButton("left")).toBe("left");
    expect(normalizeMouseButton("right")).toBe("right");
    expect(normalizeMouseButton("middle")).toBe("middle");
  });

  it("非法/缺失值回落 left（不接受任意串）", () => {
    expect(normalizeMouseButton("evil")).toBe("left");
    expect(normalizeMouseButton("")).toBe("left");
    expect(normalizeMouseButton(undefined)).toBe("left");
  });
});

describe("dispatchClick", () => {
  it("发送 mousePressed + mouseReleased（clickCount=1）", async () => {
    const { target, calls } = fakeTarget();
    expect(await dispatchClick(target, 10, 20)).toBe(true);
    expect(calls.map((c) => c.method)).toEqual([
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(calls[0]?.params).toMatchObject({ type: "mousePressed", x: 10, y: 20, clickCount: 1 });
    expect(calls[1]?.params).toMatchObject({ type: "mouseReleased" });
  });

  it("press 失败 → false 且**不**发送 release（短路）", async () => {
    const { target, calls } = fakeTarget([false]);
    expect(await dispatchClick(target, 1, 1)).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("release 失败 → false", async () => {
    const { target } = fakeTarget([true, false]);
    expect(await dispatchClick(target, 1, 1)).toBe(false);
  });

  it("非法 button 被归一并传给 CDP", async () => {
    const { target, calls } = fakeTarget();
    await dispatchClick(target, 0, 0, "weird");
    expect((calls[0]?.params as { button: string }).button).toBe("left");
  });
});

describe("dispatchDoubleClick", () => {
  it("两次完整 click（4 条命令）", async () => {
    const { target, calls } = fakeTarget();
    expect(await dispatchDoubleClick(target, 5, 5)).toBe(true);
    expect(calls.length).toBe(4);
  });

  it("第一次失败 → 立即停止（不执行第二次）", async () => {
    const { target, calls } = fakeTarget([false]);
    expect(await dispatchDoubleClick(target, 5, 5)).toBe(false);
    expect(calls.length).toBe(1);
  });
});

describe("dispatchPress", () => {
  const key = { key: "Enter", code: "Enter", keyCode: 13 };

  it("keyDown + keyUp，携带 key/code/windowsVirtualKeyCode", async () => {
    const { target, calls } = fakeTarget();
    expect(await dispatchPress(target, key)).toBe(true);
    // 注意：字段名是 windowsVirtualKeyCode（不是 keyCode）—— CDP 的命名
    expect(calls[0]?.params).toMatchObject({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    expect(calls[1]?.params).toMatchObject({ type: "keyUp", windowsVirtualKeyCode: 13 });
  });

  it("keyDown 失败 → false 且不发 keyUp", async () => {
    const { target, calls } = fakeTarget([false]);
    expect(await dispatchPress(target, key)).toBe(false);
    expect(calls.length).toBe(1);
  });
});

describe("dispatchInsertText / dispatchScroll", () => {
  it("insertText 传 text", async () => {
    const { target, calls } = fakeTarget();
    expect(await dispatchInsertText(target, "你好")).toBe(true);
    expect(calls[0]).toEqual({ method: "Input.insertText", params: { text: "你好" } });
  });

  it("scroll 传 deltaX/deltaY 且坐标为 0", async () => {
    const { target, calls } = fakeTarget();
    expect(await dispatchScroll(target, 0, 120)).toBe(true);
    expect(calls[0]?.params).toMatchObject({
      type: "mouseWheel",
      x: 0,
      y: 0,
      deltaX: 0,
      deltaY: 120,
    });
  });

  it("CDP 返回 !ok → false", async () => {
    expect(await dispatchInsertText(fakeTarget([false]).target, "x")).toBe(false);
    expect(await dispatchScroll(fakeTarget([false]).target, 0, 1)).toBe(false);
  });
});

describe("buildSelectScript — 注入防护（安全关键）", () => {
  it("selector / value / label 全部经 JSON.stringify 编码", () => {
    const script = buildSelectScript({
      selector: "#a",
      value: "v1",
      label: "标签",
    });
    expect(script).toContain('document.querySelector("#a")');
    expect(script).toContain('el.value = "v1";');
    expect(script).toContain('opt.text === "标签"');
  });

  it("selector 含引号/反引号不能逃逸（否则可注入任意代码）", () => {
    const evil = `#a"]; globalThis.PWNED = true; (("`;
    const script = buildSelectScript({ selector: evil });
    // JSON.stringify 会转义为 \" ，故不会闭合出语句
    expect(script).toContain(JSON.stringify(evil));
    // 断言：注入串以字面量形式出现，而不是裸串
    expect(script.includes(`document.querySelector("${evil}")`)).toBe(false);
  });

  it("value 含 `; alert(1);//` 不能逃逸", () => {
    const evil = `x"; alert(1); //`;
    const script = buildSelectScript({ selector: "#a", value: evil });
    expect(script).toContain(JSON.stringify(evil));
  });

  it("label 含反引号 / ${} 模板串不能逃逸", () => {
    const evil = "`${alert(1)}`";
    const script = buildSelectScript({ selector: "#a", label: evil });
    expect(script).toContain(JSON.stringify(evil));
  });

  it("仅当元素是 SELECT 才赋值（tagName 校验）", () => {
    const script = buildSelectScript({ selector: "#a", value: "v" });
    expect(script).toContain("el.tagName !== 'SELECT'");
  });

  it("派发 bubbling 的 change 事件（受控组件需要）", () => {
    const script = buildSelectScript({ selector: "#a", value: "v" });
    expect(script).toContain("new Event('change', { bubbles: true })");
  });

  it("未传 value / label 时不生成对应语句", () => {
    const script = buildSelectScript({ selector: "#a" });
    expect(script).not.toContain("el.value =");
    expect(script).not.toContain("opt.text ===");
  });

  it("value 为空串仍生成赋值（区分 undefined vs ''）", () => {
    const script = buildSelectScript({ selector: "#a", value: "" });
    expect(script).toContain('el.value = "";');
  });
});
