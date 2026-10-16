import { describe, expect, it } from "vitest";
import { ViewRegistry } from "./view-registry";

/**
 * ViewRegistry 管理 WebContentsView 的注册与 active 标记 —— 决定「哪个 view 可见」。
 * 这些用例锁定：active 切换正确性、删除 active 后的清理、thread 隔离。
 */
type FakeView = { id: string };

function view(id: string): FakeView {
  return { id };
}

describe("ViewRegistry — 注册与查询", () => {
  it("set 默认激活；get 取回同一实例", () => {
    const r = new ViewRegistry<FakeView>();
    const v = view("v1");
    r.set("t1", "tab1", v);
    expect(r.get("t1", "tab1")).toBe(v);
    expect(r.isActive("t1", "tab1")).toBe(true);
  });

  it("set activate=false 不改变 active 标记", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "tab1", view("v1"));
    r.set("t1", "tab2", view("v2"), false);
    expect(r.getActiveTabId("t1")).toBe("tab1");
  });

  it("未注册的 thread/tab 查询返回 undefined / 空", () => {
    const r = new ViewRegistry<FakeView>();
    expect(r.get("nope", "x")).toBeUndefined();
    expect(r.getViewIds("nope")).toEqual([]);
    expect(r.getCount("nope")).toBe(0);
    expect(r.getActiveTabId("nope")).toBeUndefined();
    expect(r.getActiveView("nope")).toBeUndefined();
  });

  it("getCount / getViewIds 反映已注册数量", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("1"));
    r.set("t1", "b", view("2"));
    expect(r.getCount("t1")).toBe(2);
    expect(r.getViewIds("t1").sort()).toEqual(["a", "b"]);
  });

  it("thread 之间隔离", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("1"));
    r.set("t2", "a", view("2"));
    expect(r.get("t1", "a")?.id).toBe("1");
    expect(r.get("t2", "a")?.id).toBe("2");
    expect(r.getThreadIds().sort()).toEqual(["t1", "t2"]);
  });
});

describe("ViewRegistry — active 切换", () => {
  it("setActive 切换 active 标记", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("1"));
    r.set("t1", "b", view("2"), false);
    expect(r.setActive("t1", "b")).toBe(true);
    expect(r.getActiveTabId("t1")).toBe("b");
    expect(r.isActive("t1", "a")).toBe(false);
  });

  it("setActive 未注册的 tab 返回 false 且不改变 active", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("1"));
    expect(r.setActive("t1", "ghost")).toBe(false);
    expect(r.getActiveTabId("t1")).toBe("a");
  });

  it("getActivationChange 返回需显示/隐藏的 view", () => {
    const r = new ViewRegistry<FakeView>();
    const va = view("a");
    const vb = view("b");
    r.set("t1", "a", va);
    r.set("t1", "b", vb, false);
    const change = r.getActivationChange("t1", "b");
    expect(change?.show?.id).toBe("b");
    expect(change?.hide?.id).toBe("a");
  });

  it("getActivationChange 切到同一 tab 时无 hide", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("a"));
    const change = r.getActivationChange("t1", "a");
    expect(change?.show?.id).toBe("a");
    expect(change?.hide).toBeUndefined();
  });

  it("getActivationChange 目标未注册返回 null", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("a"));
    expect(r.getActivationChange("t1", "ghost")).toBeNull();
  });

  it("首次注册无旧 active 时 hide 为空", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("a"), false);
    const change = r.getActivationChange("t1", "a");
    expect(change?.hide).toBeUndefined();
  });
});

describe("ViewRegistry — 删除与清理", () => {
  it("delete 返回被删 view 并清理 active 标记", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("a"));
    const removed = r.delete("t1", "a");
    expect(removed?.id).toBe("a");
    expect(r.getActiveTabId("t1")).toBeUndefined();
    expect(r.get("t1", "a")).toBeUndefined();
  });

  it("删除非 active view 不影响 active", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("a"));
    r.set("t1", "b", view("b"), false);
    r.delete("t1", "b");
    expect(r.getActiveTabId("t1")).toBe("a");
  });

  it("删除最后一个 view 时整个 thread 条目被清理（防泄漏）", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("a"));
    r.delete("t1", "a");
    expect(r.getThreadIds()).not.toContain("t1");
    expect(r.getCount("t1")).toBe(0);
  });

  it("clearThread 返回该 thread 所有 view 并移除条目", () => {
    const r = new ViewRegistry<FakeView>();
    r.set("t1", "a", view("a"));
    r.set("t1", "b", view("b"));
    r.set("t2", "c", view("c"));
    const cleared = r.clearThread("t1");
    expect(cleared.length).toBe(2);
    expect(r.getThreadIds()).toEqual(["t2"]);
  });

  it("clearThread 无记录返回空数组", () => {
    const r = new ViewRegistry<FakeView>();
    expect(r.clearThread("nope")).toEqual([]);
  });
});
