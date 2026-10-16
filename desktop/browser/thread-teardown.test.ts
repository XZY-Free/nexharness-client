import { describe, expect, it } from "vitest";
import { CLEANUP_STEPS, type ThreadTeardownDeps, teardownThread } from "./thread-teardown";

/**
 * Thread 关闭清理是**资源清单** —— 漏一项就泄漏。
 * 这些用例把"每一项都被调用"固化为断言（新增资源时测试会强制覆盖）。
 */
function fakeDeps(over: Partial<ThreadTeardownDeps> = {}) {
  const log: string[] = [];
  const deps: ThreadTeardownDeps = {
    getViewIds: () => ["tab-a", "tab-b"],
    removeAndCloseView: (_t, tabId) => {
      log.push(`removeView:${tabId}`);
      return tabId === "tab-a" ? 101 : 102;
    },
    forgetWebContents: (id) => log.push(`forgetWebContents:${id}`),
    forgetBounds: (_t, tabId) => log.push(`forgetBounds:${tabId}`),
    clearViews: () => log.push("clearViews"),
    clearDebuggerSessions: () => log.push("clearDebuggerSessions"),
    releaseMonitoring: (_t, tabId) => log.push(`releaseMonitoring:${tabId}`),
    clearPageInsights: () => log.push("clearPageInsights"),
    destroyIncognitoPartitions: () => log.push("destroyIncognitoPartitions"),
    clearDownloads: () => log.push("clearDownloads"),
    cleanupTempFiles: () => log.push("cleanupTempFiles"),
    closeQa: () => log.push("closeQa"),
    closeAllTabs: () => {
      log.push("closeAllTabs");
      return 2;
    },
    deleteRestoreRecord: () => log.push("deleteRestoreRecord"),
    ...over,
  };
  return { deps, log };
}

describe("teardownThread — 清理清单完整性与顺序", () => {
  it("返回 closeAllTabs 的数量", () => {
    const { deps } = fakeDeps();
    expect(teardownThread("t1", deps)).toBe(2);
  });

  it("**每一项清理都被调用**（清单完整性）", () => {
    const { deps, log } = fakeDeps();
    teardownThread("t1", deps);
    const called = new Set(log.map((l) => l.split(":")[0]));
    // 清单步骤名 → 可观测调用名（逐项显式映射，避免"名字像但没调用"的假通过）
    const OBSERVABLE: Record<string, string> = {
      removeAndCloseView: "removeView",
      forgetWebContentsIndex: "forgetWebContents",
      forgetBounds: "forgetBounds",
      clearViewRegistry: "clearViews",
      clearDebuggerSessions: "clearDebuggerSessions",
      releaseMonitoring: "releaseMonitoring",
      clearPageInsights: "clearPageInsights",
      destroyIncognitoPartitions: "destroyIncognitoPartitions",
      clearDownloads: "clearDownloads",
      cleanupTempFiles: "cleanupTempFiles",
      closeQa: "closeQa",
      closeAllTabs: "closeAllTabs",
      deleteRestoreRecord: "deleteRestoreRecord",
    };
    for (const step of CLEANUP_STEPS) {
      const observable = OBSERVABLE[step];
      expect(observable, `清单步骤缺少观测映射：${step}`).toBeDefined();
      expect(called.has(observable as string), `清理步骤未被执行：${step}`).toBe(true);
    }
  });

  it("每个 tab 都被移除 view、清反向索引、清 bounds、释放监控", () => {
    const { deps, log } = fakeDeps();
    teardownThread("t1", deps);
    for (const tab of ["tab-a", "tab-b"]) {
      expect(log).toContain(`removeView:${tab}`);
      expect(log).toContain(`forgetBounds:${tab}`);
      expect(log).toContain(`releaseMonitoring:${tab}`);
    }
    expect(log).toContain("forgetWebContents:101");
    expect(log).toContain("forgetWebContents:102");
  });

  it("顺序：先移除 view → 再清缓冲 → 最后关 tab 状态 + 删持久化", () => {
    const { deps, log } = fakeDeps();
    teardownThread("t1", deps);
    const idx = (name: string) => log.indexOf(name);
    expect(idx("removeView:tab-a")).toBeLessThan(idx("clearViews"));
    expect(idx("clearViews")).toBeLessThan(idx("clearPageInsights"));
    expect(idx("clearPageInsights")).toBeLessThan(idx("closeAllTabs"));
    expect(idx("closeAllTabs")).toBeLessThan(idx("deleteRestoreRecord"));
  });

  it("view 不存在（removeAndCloseView 返回 null）→ 跳过反向索引清理但不崩", () => {
    const { deps, log } = fakeDeps({
      removeAndCloseView: (_t, tabId) => {
        log.push(`removeView:${tabId}`);
        return null;
      },
    });
    expect(() => teardownThread("t1", deps)).not.toThrow();
    expect(log.some((l) => l.startsWith("forgetWebContents"))).toBe(false);
    // bounds 仍需清理（避免残留）
    expect(log).toContain("forgetBounds:tab-a");
  });

  it("无 tab → 仍执行各类缓冲清理与 closeAllTabs", () => {
    const { deps, log } = fakeDeps({ getViewIds: () => [] });
    teardownThread("t1", deps);
    expect(log).toContain("clearViews");
    expect(log).toContain("closeAllTabs");
  });

  it("可选子系统（downloads / qa / restore）缺失时不崩", () => {
    const { deps } = fakeDeps({
      clearDownloads: undefined,
      closeQa: undefined,
      deleteRestoreRecord: undefined,
    });
    expect(() => teardownThread("t1", deps)).not.toThrow();
  });

  it("viewId 快照只取一次（中途变化不影响本次清理）", () => {
    let calls = 0;
    const { deps, log } = fakeDeps({
      getViewIds: () => {
        calls += 1;
        return ["tab-a"];
      },
    });
    teardownThread("t1", deps);
    expect(calls).toBe(1);
    expect(log).toContain("removeView:tab-a");
  });
});

describe("CLEANUP_STEPS — 清单自检", () => {
  it("清单无重复项", () => {
    expect(new Set(CLEANUP_STEPS).size).toBe(CLEANUP_STEPS.length);
  });

  it("清单覆盖已知的全部资源类别", () => {
    for (const required of [
      "removeAndCloseView",
      "clearViewRegistry",
      "clearDebuggerSessions",
      "releaseMonitoring",
      "clearPageInsights",
      "destroyIncognitoPartitions",
      "clearDownloads",
      "cleanupTempFiles",
      "closeQa",
      "closeAllTabs",
      "deleteRestoreRecord",
    ]) {
      expect(CLEANUP_STEPS as readonly string[]).toContain(required);
    }
  });
});
