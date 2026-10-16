import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEASE_TTL_MS,
  LeaseManager,
  isLeaseForUser,
  isLeaseHeldBy,
  isLeaseValid,
  needsRenewal,
} from "./lease";

/**
 * BrowserLease 是「谁独占某 thread 的浏览器」的服务端事实源。
 * 这些用例锁定：跨设备互斥、身份校验、过期与续期阈值。
 */
const T0 = 1_000_000;

function lease(over = {}) {
  return {
    threadId: "t1",
    userId: "u1",
    deviceRecordId: "dev1",
    acquiredAt: T0,
    expiresAt: T0 + 300,
    ...over,
  };
}

describe("isLeaseValid", () => {
  it("now < expiresAt 有效；now === expiresAt 视为过期", () => {
    expect(isLeaseValid(lease(), T0 + 299)).toBe(true);
    expect(isLeaseValid(lease(), T0 + 300)).toBe(false);
    expect(isLeaseValid(lease(), T0 + 301)).toBe(false);
  });
});

describe("isLeaseHeldBy / isLeaseForUser", () => {
  it("按 deviceRecordId 判定持有者", () => {
    expect(isLeaseHeldBy(lease(), "dev1")).toBe(true);
    expect(isLeaseHeldBy(lease(), "dev2")).toBe(false);
  });

  it("isLeaseForUser 需 userId + threadId 同时匹配", () => {
    expect(isLeaseForUser(lease(), "u1", "t1")).toBe(true);
    expect(isLeaseForUser(lease(), "u2", "t1")).toBe(false);
    expect(isLeaseForUser(lease(), "u1", "t2")).toBe(false);
  });
});

describe("needsRenewal", () => {
  it("剩余 < 1/3 TTL 时需续期（TTL=300 → 阈值 100ms）", () => {
    expect(needsRenewal(lease(), T0 + 100)).toBe(false); // 剩余 200
    expect(needsRenewal(lease(), T0 + 201)).toBe(true); // 剩余 99
  });

  it("已过期视为需续期", () => {
    expect(needsRenewal(lease(), T0 + 500)).toBe(true);
  });
});

describe("LeaseManager", () => {
  it("无 lease 时可获取，默认 TTL 生效", () => {
    const m = new LeaseManager();
    const r = m.acquireLease("t1", "u1", "dev1", DEFAULT_LEASE_TTL_MS, T0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lease.expiresAt).toBe(T0 + DEFAULT_LEASE_TTL_MS);
  });

  it("同设备续期（不冲突）；不同设备有效持有则拒绝", () => {
    const m = new LeaseManager();
    m.acquireLease("t1", "u1", "dev1", DEFAULT_LEASE_TTL_MS, T0);
    const same = m.acquireLease("t1", "u1", "dev1", DEFAULT_LEASE_TTL_MS, T0 + 100);
    expect(same.ok).toBe(true);

    const other = m.acquireLease("t1", "u2", "dev2", DEFAULT_LEASE_TTL_MS, T0 + 100);
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("lease_held_by_other");
    expect(m.getLease("t1")?.deviceRecordId).toBe("dev1");
  });

  it("前 lease 过期后其它设备可获取", () => {
    const m = new LeaseManager();
    m.acquireLease("t1", "u1", "dev1", 100, T0);
    const r = m.acquireLease("t1", "u2", "dev2", DEFAULT_LEASE_TTL_MS, T0 + 200);
    expect(r.ok).toBe(true);
    expect(m.getLease("t1")?.deviceRecordId).toBe("dev2");
  });

  it("releaseLease 需持有者匹配", () => {
    const m = new LeaseManager();
    m.acquireLease("t1", "u1", "dev1", DEFAULT_LEASE_TTL_MS, T0);
    expect(m.releaseLease("t1", "dev2", T0)).toBe(false);
    expect(m.getLease("t1")).not.toBeNull();
    expect(m.releaseLease("t1", "dev1", T0)).toBe(true);
    expect(m.getLease("t1")).toBeNull();
  });

  it("revokeLease 强制撤销", () => {
    const m = new LeaseManager();
    m.acquireLease("t1", "u1", "dev1", DEFAULT_LEASE_TTL_MS, T0);
    expect(m.revokeLease("t1")).toBe(true);
    expect(m.getLease("t1")).toBeNull();
    expect(m.revokeLease("t1")).toBe(false);
  });

  it("cleanupExpired 只清过期 lease", () => {
    const m = new LeaseManager();
    m.acquireLease("t1", "u1", "dev1", 100, T0);
    m.acquireLease("t2", "u1", "dev1", 100_000, T0);
    expect(m.cleanupExpired(T0 + 500)).toBe(1);
    expect(m.getLease("t1")).toBeNull();
    expect(m.getLease("t2")).not.toBeNull();
  });

  it("getActiveLeases 返回当前持有的 lease 列表", () => {
    const m = new LeaseManager();
    m.acquireLease("t1", "u1", "dev1", DEFAULT_LEASE_TTL_MS, T0);
    m.acquireLease("t2", "u2", "dev2", DEFAULT_LEASE_TTL_MS, T0);
    expect(m.getActiveLeases().length).toBe(2);
  });

  it("thread 之间独立互斥", () => {
    const m = new LeaseManager();
    m.acquireLease("t1", "u1", "dev1", DEFAULT_LEASE_TTL_MS, T0);
    expect(m.acquireLease("t2", "u1", "dev2", DEFAULT_LEASE_TTL_MS, T0).ok).toBe(true);
  });
});
