import { describe, expect, it, vi } from "vitest";
import { DebuggerSessionScheduler } from "./debugger-session-scheduler";

/**
 * 引用计数调度器决定 CDP attach 的生命周期（漏 detach 会泄漏调试会话）。
 * 这些用例锁定：同 key 复用不重复 attach、归零才 detach、失败路径不残留。
 */
function makeTarget() {
  let attached = false;
  return {
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    isAttached: vi.fn(() => attached),
    sendCommand: vi.fn(async () => ({ ok: true as const, result: { echoed: true } })),
  };
}

describe("DebuggerSessionScheduler — 引用计数", () => {
  it("首次 acquire 目标时必须 attach，refCount=1", async () => {
    const target = makeTarget();
    const s = new DebuggerSessionScheduler(() => target);
    const got = await s.acquire("t1", "tab1");
    expect(got).toBe(target);
    expect(target.attach).toHaveBeenCalledTimes(1);
    expect(s.getRefCount("t1", "tab1")).toBe(1);
  });

  it("同 key 重复 acquire 复用并累加计数，不再 attach", async () => {
    const target = makeTarget();
    const s = new DebuggerSessionScheduler(() => target);
    await s.acquire("t1", "tab1");
    await s.acquire("t1", "tab1");
    await s.acquire("t1", "tab1");
    expect(s.getRefCount("t1", "tab1")).toBe(3);
    expect(target.attach).toHaveBeenCalledTimes(1);
  });

  it("release 递减计数；归零才 detach 并移除", async () => {
    const target = makeTarget();
    const s = new DebuggerSessionScheduler(() => target);
    await s.acquire("t1", "tab1");
    await s.acquire("t1", "tab1");

    s.release("t1", "tab1");
    expect(s.getRefCount("t1", "tab1")).toBe(1);
    expect(target.detach).not.toHaveBeenCalled(); // 尚未归零

    s.release("t1", "tab1");
    expect(target.detach).toHaveBeenCalledTimes(1);
    expect(s.hasSession("t1", "tab1")).toBe(false);
    expect(s.getRefCount("t1", "tab1")).toBe(0);
  });

  it("release 未持有的 key 为静默 no-op（不抛错、不误 detach）", () => {
    const target = makeTarget();
    const s = new DebuggerSessionScheduler(() => target);
    expect(() => s.release("t1", "tab1")).not.toThrow();
    expect(target.detach).not.toHaveBeenCalled();
  });

  it("不同 tab 独立计数（不串号）", async () => {
    const t1 = makeTarget();
    const t2 = makeTarget();
    const s = new DebuggerSessionScheduler((_t, tabId) => (tabId === "tab1" ? t1 : t2));
    await s.acquire("t1", "tab1");
    await s.acquire("t1", "tab2");
    expect(s.getRefCount("t1", "tab1")).toBe(1);
    expect(s.getRefCount("t1", "tab2")).toBe(1);
    s.release("t1", "tab1");
    expect(t1.detach).toHaveBeenCalledTimes(1);
    expect(t2.detach).not.toHaveBeenCalled();
  });

  it("targetFactory 返回 null 时不记录 session", async () => {
    const s = new DebuggerSessionScheduler(() => null);
    expect(await s.acquire("t1", "tab1")).toBeNull();
    expect(s.hasSession("t1", "tab1")).toBe(false);
    expect(s.getRefCount("t1", "tab1")).toBe(0);
  });

  it("target 已 attach 时 acquire 不重复 attach", async () => {
    const target = makeTarget();
    target.attach(); // 预置已 attach 状态
    const s = new DebuggerSessionScheduler(() => target);
    await s.acquire("t1", "tab1");
    expect(target.attach).toHaveBeenCalledTimes(1); // 只有预置那次
  });

  it("attach 抛错时 acquire 返回 null 且不记录 session", async () => {
    const target = makeTarget();
    target.attach.mockImplementation(() => {
      throw new Error("attach failed");
    });
    const s = new DebuggerSessionScheduler(() => target);
    expect(await s.acquire("t1", "tab1")).toBeNull();
    expect(s.hasSession("t1", "tab1")).toBe(false);
  });

  it("detach 抛错时仍清理 session（不残留）", async () => {
    const target = makeTarget();
    const s = new DebuggerSessionScheduler(() => target);
    await s.acquire("t1", "tab1");
    target.detach.mockImplementation(() => {
      throw new Error("detach failed");
    });
    expect(() => s.release("t1", "tab1")).not.toThrow();
    expect(s.hasSession("t1", "tab1")).toBe(false);
  });
});

describe("DebuggerSessionScheduler — sendCommand 自动收尾", () => {
  it("sendCommand 自动 acquire + release（一次性命令不留 session）", async () => {
    const target = makeTarget();
    const s = new DebuggerSessionScheduler(() => target);
    const r = await s.sendCommand("t1", "tab1", "Runtime.evaluate", {});
    expect(r.ok).toBe(true);
    expect(s.hasSession("t1", "tab1")).toBe(false); // 已释放
    expect(target.detach).toHaveBeenCalledTimes(1);
  });

  it("sendCommand 在 target 不可用时返回 tab_not_found", async () => {
    const s = new DebuggerSessionScheduler(() => null);
    const r = await s.sendCommand("t1", "tab1", "Runtime.evaluate");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("tab_not_found");
  });

  it("sendCommand 在 target 抛错时仍释放 session（finally）", async () => {
    const target = makeTarget();
    target.sendCommand.mockRejectedValue(new Error("cdp error"));
    const s = new DebuggerSessionScheduler(() => target);
    await expect(s.sendCommand("t1", "tab1", "X")).rejects.toThrow("cdp error");
    expect(s.hasSession("t1", "tab1")).toBe(false);
  });
});

describe("DebuggerSessionScheduler — clearThread / clearAll", () => {
  it("clearThread 只清该 thread 的 session 并 detach", async () => {
    // 每个 (thread, tab) 有独立 target（真实场景），用 key 派生
    const targets = new Map<string, ReturnType<typeof makeTarget>>();
    const s = new DebuggerSessionScheduler((threadId, tabId) => {
      const key = `${threadId}:${tabId}`;
      if (!targets.has(key)) targets.set(key, makeTarget());
      return targets.get(key) ?? null;
    });
    await s.acquire("t1", "tab1");
    await s.acquire("t1", "tab2");
    await s.acquire("t2", "tab1");

    const cleared = s.clearThread("t1");
    expect(cleared).toBe(2);
    expect(targets.get("t1:tab1")?.detach).toHaveBeenCalledTimes(1);
    expect(targets.get("t1:tab2")?.detach).toHaveBeenCalledTimes(1);
    expect(targets.get("t2:tab1")?.detach).not.toHaveBeenCalled();
    expect(s.hasSession("t2", "tab1")).toBe(true);
    expect(s.hasSession("t1", "tab1")).toBe(false);
  });

  it("clearAll 清空所有并 detach", async () => {
    const targets: ReturnType<typeof makeTarget>[] = [];
    const s = new DebuggerSessionScheduler(() => {
      const t = makeTarget();
      targets.push(t);
      return t;
    });
    await s.acquire("t1", "tab1");
    await s.acquire("t2", "tab1");
    s.clearAll();
    expect(s.hasSession("t1", "tab1")).toBe(false);
    expect(s.hasSession("t2", "tab1")).toBe(false);
    for (const t of targets) expect(t.detach).toHaveBeenCalled();
  });
});
