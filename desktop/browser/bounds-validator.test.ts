import { describe, expect, it } from "vitest";
import { MIN_BOUNDS_SIZE, boundsChanged, hiddenBounds, validateBounds } from "./bounds-validator";

/**
 * bounds 校验是主进程对 renderer 输入的信任边界（renderer 可被页面脚本影响）。
 * 这些用例锁定：非法数值一律拒绝、不越窗、返回取整后的安全值。
 */
describe("validateBounds — 输入信任边界", () => {
  const win = { windowWidth: 1400, windowHeight: 900 };

  it("合法 bounds 通过并取整", () => {
    const r = validateBounds({ x: 10.4, y: 20.6, width: 100.5, height: 50.2 }, win, 2);
    expect(r.ok).toBe(true);
    expect(r.bounds).toEqual({ x: 10, y: 21, width: 101, height: 50 });
  });

  it("非对象 / null / 数组（无 x/y/width/height 字段）拒绝", () => {
    expect(validateBounds(null, win, 1).ok).toBe(false);
    expect(validateBounds("x", win, 1).ok).toBe(false);
    expect(validateBounds(undefined, win, 1).ok).toBe(false);
    expect(validateBounds([1, 2, 3, 4], win, 1).ok).toBe(false);
  });

  it("NaN / Infinity 一律拒绝（防渲染进程注入异常数值）", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(validateBounds({ x: bad, y: 0, width: 10, height: 10 }, win, 1).ok).toBe(false);
      expect(validateBounds({ x: 0, y: bad, width: 10, height: 10 }, win, 1).ok).toBe(false);
      expect(validateBounds({ x: 0, y: 0, width: bad, height: 10 }, win, 1).ok).toBe(false);
      expect(validateBounds({ x: 0, y: 0, width: 10, height: bad }, win, 1).ok).toBe(false);
    }
  });

  it("字段缺失 / 非 number 拒绝", () => {
    expect(validateBounds({ y: 0, width: 1, height: 1 }, win, 1).ok).toBe(false);
    expect(validateBounds({ x: "0", y: 0, width: 1, height: 1 }, win, 1).ok).toBe(false);
  });

  it("负数 x / y 拒绝", () => {
    expect(validateBounds({ x: -1, y: 0, width: 10, height: 10 }, win, 1).ok).toBe(false);
    expect(validateBounds({ x: 0, y: -1, width: 10, height: 10 }, win, 1).ok).toBe(false);
  });

  it("width / height 小于最小尺寸拒绝（含 0 与负）", () => {
    expect(validateBounds({ x: 0, y: 0, width: 0, height: 10 }, win, 1).ok).toBe(false);
    expect(validateBounds({ x: 0, y: 0, width: -5, height: 10 }, win, 1).ok).toBe(false);
    // 恰好等于最小值应通过
    expect(
      validateBounds({ x: 0, y: 0, width: MIN_BOUNDS_SIZE, height: MIN_BOUNDS_SIZE }, win, 1).ok,
    ).toBe(true);
  });

  it("超出窗口右/下边界拒绝（防止覆盖工具栏）", () => {
    expect(validateBounds({ x: 1300, y: 0, width: 200, height: 100 }, win, 1).ok).toBe(false);
    expect(validateBounds({ x: 0, y: 850, width: 100, height: 100 }, win, 1).ok).toBe(false);
    // 恰好贴边应通过
    expect(validateBounds({ x: 1300, y: 800, width: 100, height: 100 }, win, 1).ok).toBe(true);
  });

  it("scaleFactor 非正 / 非有限拒绝", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateBounds({ x: 0, y: 0, width: 10, height: 10 }, win, bad).ok).toBe(false);
    }
  });
});

describe("boundsChanged — 亚像素抖动抑制", () => {
  it("差异 >= 1px 判为变化", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(boundsChanged(a, { x: 1, y: 0, width: 100, height: 100 })).toBe(true);
    expect(boundsChanged(a, { x: 0, y: 0, width: 101, height: 100 })).toBe(true);
  });

  it("差异 < 1px 判为未变化（减少无谓 setBounds）", () => {
    const a = { x: 0, y: 0, width: 100, height: 100 };
    expect(boundsChanged(a, { x: 0.4, y: 0.9, width: 100.5, height: 100 })).toBe(false);
    expect(boundsChanged(a, a)).toBe(false);
  });
});

describe("hiddenBounds", () => {
  it("返回 1x1 最小 bounds（不用 0 尺寸，防 Chromium 崩溃）", () => {
    expect(hiddenBounds()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});
