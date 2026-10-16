import { describe, expect, it, vi } from "vitest";
import { TabStore } from "./tab-store";

/**
 * TabStore 是 tab 状态机 + 变更事件源（BrowserController 持久化依赖它）。
 * 这些用例锁定：active 自动切换规则、reorder 校验、事件载荷、thread 隔离。
 */
describe("TabStore — 创建与查询", () => {
  it("createTab 写入字段并默认激活", () => {
    const s = new TabStore();
    const tab = s.createTab("t1", "https://x/a");
    expect(tab.url).toBe("https://x/a");
    expect(tab.threadId).toBe("t1");
    expect(s.getActiveTab("t1")?.id).toBe(tab.id);
    expect(s.getTabCount("t1")).toBe(1);
  });

  it("activate=false 时不改变 active", () => {
    const s = new TabStore();
    const first = s.createTab("t1", "https://x/1");
    s.createTab("t1", "https://x/2", { activate: false });
    expect(s.getActiveTab("t1")?.id).toBe(first.id);
  });

  it("可指定 tabId（用于恢复）", () => {
    const s = new TabStore();
    const tab = s.createTab("t1", "https://x", { tabId: "fixed-id" });
    expect(tab.id).toBe("fixed-id");
    expect(s.getTab("t1", "fixed-id")?.id).toBe("fixed-id");
  });

  it("未注册 thread 查询返回空/null", () => {
    const s = new TabStore();
    expect(s.getTabs("nope")).toEqual([]);
    expect(s.getTab("nope", "x")).toBeNull();
    expect(s.getActiveTab("nope")).toBeNull();
    expect(s.getThreadState("nope")).toBeNull();
    expect(s.getTabCount("nope")).toBe(0);
  });

  it("thread 之间隔离", () => {
    const s = new TabStore();
    s.createTab("t1", "https://x/1");
    s.createTab("t2", "https://x/2");
    expect(s.getTabCount("t1")).toBe(1);
    expect(s.getTabCount("t2")).toBe(1);
    expect(s.getThreadIds().sort()).toEqual(["t1", "t2"]);
  });
});

describe("TabStore — closeTab 的 active 自动切换", () => {
  it("关闭 active tab 时切换到右侧相邻", () => {
    const s = new TabStore();
    const a = s.createTab("t1", "https://a");
    const b = s.createTab("t1", "https://b", { activate: false });
    const c = s.createTab("t1", "https://c", { activate: false });
    s.setActiveTab("t1", b.id);
    s.closeTab("t1", b.id);
    expect(s.getActiveTab("t1")?.id).toBe(c.id); // 右侧优先
    expect(s.getTabs("t1").map((t) => t.id)).toEqual([a.id, c.id]);
  });

  it("关闭最右侧 active tab 时回退到左侧", () => {
    const s = new TabStore();
    const a = s.createTab("t1", "https://a");
    const b = s.createTab("t1", "https://b", { activate: false });
    s.setActiveTab("t1", b.id);
    s.closeTab("t1", b.id);
    expect(s.getActiveTab("t1")?.id).toBe(a.id);
  });

  it("关闭最后一个 tab 时 active 置 null", () => {
    const s = new TabStore();
    const a = s.createTab("t1", "https://a");
    s.closeTab("t1", a.id);
    expect(s.getActiveTab("t1")).toBeNull();
  });

  it("关闭非 active tab 不影响 active", () => {
    const s = new TabStore();
    const a = s.createTab("t1", "https://a");
    const b = s.createTab("t1", "https://b", { activate: false });
    s.closeTab("t1", b.id);
    expect(s.getActiveTab("t1")?.id).toBe(a.id);
  });

  it("关闭不存在的 tab / thread 返回 null", () => {
    const s = new TabStore();
    s.createTab("t1", "https://a");
    expect(s.closeTab("t1", "ghost")).toBeNull();
    expect(s.closeTab("nope", "x")).toBeNull();
  });
});

describe("TabStore — setActiveTab / updateTab", () => {
  it("setActiveTab 切换到已存在 tab 返回 true", () => {
    const s = new TabStore();
    const a = s.createTab("t1", "https://a");
    const b = s.createTab("t1", "https://b", { activate: false });
    expect(s.setActiveTab("t1", b.id)).toBe(true);
    expect(s.getActiveTab("t1")?.id).toBe(b.id);
    expect(s.setActiveTab("t1", a.id)).toBe(true);
  });

  it("setActiveTab 到不存在的 tab / thread 返回 false", () => {
    const s = new TabStore();
    s.createTab("t1", "https://a");
    expect(s.setActiveTab("t1", "ghost")).toBe(false);
    expect(s.setActiveTab("nope", "x")).toBe(false);
  });

  it("updateTab 合并字段但锁定 id/threadId/createdAt", () => {
    const s = new TabStore();
    const tab = s.createTab("t1", "https://a");
    const updated = s.updateTab("t1", tab.id, {
      title: "New",
      // @ts-expect-error 运行时也应被锁定
      id: "hacked",
      threadId: "other",
      createdAt: 0,
    });
    expect(updated?.title).toBe("New");
    expect(updated?.id).toBe(tab.id);
    expect(updated?.threadId).toBe("t1");
    expect(updated?.createdAt).toBe(tab.createdAt);
  });

  it("updateTab 不存在的 tab 返回 null", () => {
    const s = new TabStore();
    expect(s.updateTab("nope", "x", {})).toBeNull();
  });
});

describe("TabStore — reorderTabs 校验", () => {
  it("合法的完整重排成功", () => {
    const s = new TabStore();
    const a = s.createTab("t1", "https://a");
    const b = s.createTab("t1", "https://b", { activate: false });
    expect(s.reorderTabs("t1", [b.id, a.id])).toBe(true);
    expect(s.getTabs("t1").map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("缺项 / 多项 / 含未知 id 一律拒绝（防丢 tab）", () => {
    const s = new TabStore();
    const a = s.createTab("t1", "https://a");
    const b = s.createTab("t1", "https://b", { activate: false });
    expect(s.reorderTabs("t1", [a.id])).toBe(false); // 缺 b
    expect(s.reorderTabs("t1", [a.id, b.id, "extra"])).toBe(false); // 多项
    expect(s.reorderTabs("t1", ["x", "y"])).toBe(false); // 未知
    // 原顺序未被破坏
    expect(s.getTabs("t1").map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("不存在的 thread 返回 false", () => {
    const s = new TabStore();
    expect(s.reorderTabs("nope", [])).toBe(false);
  });
});

describe("TabStore — closeAllTabs", () => {
  it("关闭全部并移除 thread 条目，返回数量", () => {
    const s = new TabStore();
    s.createTab("t1", "https://a");
    s.createTab("t1", "https://b", { activate: false });
    expect(s.closeAllTabs("t1")).toBe(2);
    expect(s.getTabCount("t1")).toBe(0);
    expect(s.getThreadIds()).not.toContain("t1");
  });

  it("无记录返回 0", () => {
    const s = new TabStore();
    expect(s.closeAllTabs("nope")).toBe(0);
  });
});

describe("TabStore — 事件订阅", () => {
  it("createTab 触发 tab-created（+ 激活时 active-tab-changed）", () => {
    const s = new TabStore();
    const events: string[] = [];
    s.subscribe((e) => events.push(e.type));
    s.createTab("t1", "https://a");
    expect(events).toContain("tab-created");
    expect(events).toContain("active-tab-changed");
  });

  it("closeTab 触发 tab-closed", () => {
    const s = new TabStore();
    const tab = s.createTab("t1", "https://a");
    const events: string[] = [];
    s.subscribe((e) => events.push(e.type));
    s.closeTab("t1", tab.id);
    expect(events).toContain("tab-closed");
  });

  it("updateTab 触发 tab-updated 且载荷为新对象", () => {
    const s = new TabStore();
    const tab = s.createTab("t1", "https://a");
    const spy = vi.fn();
    s.subscribe(spy);
    s.updateTab("t1", tab.id, { title: "T" });
    const updatedEvent = spy.mock.calls.map((c) => c[0]).find((e) => e.type === "tab-updated");
    expect(updatedEvent?.tab.title).toBe("T");
  });

  it("reorderTabs 成功才触发 tab-reordered", () => {
    const s = new TabStore();
    const a = s.createTab("t1", "https://a");
    const b = s.createTab("t1", "https://b", { activate: false });
    const spy = vi.fn();
    s.subscribe(spy);
    s.reorderTabs("t1", [a.id]); // 非法，不应触发
    expect(spy).not.toHaveBeenCalled();
    s.reorderTabs("t1", [b.id, a.id]);
    expect(spy.mock.calls.map((c) => c[0].type)).toContain("tab-reordered");
  });

  it("取消订阅后不再收到事件", () => {
    const s = new TabStore();
    const cb = vi.fn();
    const off = s.subscribe(cb);
    s.createTab("t1", "https://a");
    const count = cb.mock.calls.length;
    off();
    s.createTab("t1", "https://b", { activate: false });
    expect(cb.mock.calls.length).toBe(count);
  });
});
