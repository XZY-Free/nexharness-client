import { describe, expect, it } from "vitest";
import { SessionManager } from "./session-manager";

/**
 * SessionManager 管理 Electron partition —— 决定「谁能共享 cookie/存储」。
 * 这些用例锁定：用户隔离、临时会话（incognito）不串号、可清理。
 */
describe("SessionManager — 用户分区隔离", () => {
  it("同一 userId 返回同一 partition（幂等）", () => {
    const m = new SessionManager();
    const a = m.getOrCreateBrowserPartition("user-1");
    const b = m.getOrCreateBrowserPartition("user-1");
    expect(a).toBe(b);
  });

  it("不同 userId 得到不同 partition（防跨用户 cookie 串用）", () => {
    const m = new SessionManager();
    expect(m.getOrCreateBrowserPartition("user-1")).not.toBe(
      m.getOrCreateBrowserPartition("user-2"),
    );
  });

  it("getUserIds 列出已登记用户", () => {
    const m = new SessionManager();
    m.getOrCreateBrowserPartition("u1");
    m.getOrCreateBrowserPartition("u2");
    expect(m.getUserIds().sort()).toEqual(["u1", "u2"]);
  });

  it("removeBrowserProfile 移除登记，再次获取得到新 partition", () => {
    const m = new SessionManager();
    const before = m.getOrCreateBrowserPartition("u1");
    expect(m.removeBrowserProfile("u1")).toBe(true);
    expect(m.removeBrowserProfile("u1")).toBe(false); // 已不存在
    expect(m.getUserIds()).not.toContain("u1");
    const after = m.getOrCreateBrowserPartition("u1");
    // 重新登记可能得到同名 partition（按 userId 派生），但登记状态已重建
    expect(typeof after).toBe("string");
    expect(before).toBe(after);
  });
});

describe("SessionManager — 临时会话（incognito）", () => {
  it("同一 threadId 多次创建返回相同 partition（复用）", () => {
    const m = new SessionManager();
    expect(m.createIncognitoPartition("t1")).toBe(m.createIncognitoPartition("t1"));
  });

  it("不同 threadId 得到不同 partition", () => {
    const m = new SessionManager();
    expect(m.createIncognitoPartition("t1")).not.toBe(m.createIncognitoPartition("t2"));
  });

  it("getIncognitoCount 反映该 thread 的临时分区数", () => {
    const m = new SessionManager();
    expect(m.getIncognitoCount("t1")).toBe(0);
    m.createIncognitoPartition("t1");
    expect(m.getIncognitoCount("t1")).toBe(1);
  });

  it("destroyIncognitoPartitions 清空该 thread 并返回被销毁列表", () => {
    const m = new SessionManager();
    m.createIncognitoPartition("t1");
    m.createIncognitoPartition("t2");
    const destroyed = m.destroyIncognitoPartitions("t1");
    expect(destroyed.length).toBe(1);
    expect(m.getIncognitoCount("t1")).toBe(0);
    expect(m.getIncognitoCount("t2")).toBe(1); // 不误伤其它 thread
  });

  it("destroy 无记录时返回空数组", () => {
    const m = new SessionManager();
    expect(m.destroyIncognitoPartitions("nope")).toEqual([]);
  });

  it("临时分区与用户分区命名空间不冲突", () => {
    const m = new SessionManager();
    const userPart = m.getOrCreateBrowserPartition("u1");
    const incognito = m.createIncognitoPartition("u1");
    expect(incognito).not.toBe(userPart);
  });
});
