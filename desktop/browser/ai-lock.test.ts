import { describe, expect, it, vi } from "vitest";
import { AI_LOCK_DEFAULT_TTL_MS, AiLockManager, isLockValid, lockNeedsRenewal } from "./ai-lock";

/**
 * AI 锁是「AI 操作 vs 用户操作」的互斥闸（Server 是事实源，本地为 Secondary 强制）。
 * 这些用例锁定：跨设备拒绝、释放需身份匹配、用户始终可取消、过期降级语义。
 */
const T0 = 1_000_000;

function acquireParams(over: Partial<Parameters<AiLockManager["acquire"]>[0]> = {}) {
  return {
    threadId: "t1",
    userId: "u1",
    deviceId: "dev1",
    runId: "run1",
    now: T0,
    ...over,
  };
}

describe("isLockValid / lockNeedsRenewal", () => {
  const lock = {
    threadId: "t",
    userId: "u",
    deviceId: "d",
    runId: "r",
    acquiredAt: T0,
    expiresAt: T0 + 300,
  };

  it("now < expiresAt 有效；now === expiresAt 视为已过期", () => {
    expect(isLockValid(lock, T0 + 299)).toBe(true);
    expect(isLockValid(lock, T0 + 300)).toBe(false);
    expect(isLockValid(lock, T0 + 301)).toBe(false);
  });

  it("剩余 < 1/3 TTL 时需续期", () => {
    // TTL=300，阈值 100ms → 剩余 <100 需续期
    expect(lockNeedsRenewal(lock, T0 + 100)).toBe(false); // 剩余 200
    expect(lockNeedsRenewal(lock, T0 + 201)).toBe(true); // 剩余 99
  });

  it("已过期视为需要续期", () => {
    expect(lockNeedsRenewal(lock, T0 + 500)).toBe(true);
  });
});

describe("AiLockManager — acquire 互斥语义", () => {
  it("无锁时可获取，写入正确字段与 TTL", () => {
    const m = new AiLockManager();
    const r = m.acquire(acquireParams());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lock.threadId).toBe("t1");
      expect(r.lock.runId).toBe("run1");
      expect(r.lock.acquiredAt).toBe(T0);
      expect(r.lock.expiresAt).toBe(T0 + AI_LOCK_DEFAULT_TTL_MS);
    }
  });

  it("同设备 + 同 runId 续期（expiresAt 前移）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams());
    const r = m.acquire(acquireParams({ now: T0 + 1000 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lock.expiresAt).toBe(T0 + 1000 + AI_LOCK_DEFAULT_TTL_MS);
  });

  it("同设备 + 不同 runId 替换锁（新 runId 接管）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams());
    const r = m.acquire(acquireParams({ runId: "run2" }));
    expect(r.ok).toBe(true);
    expect(m.getLock("t1")?.runId).toBe("run2");
  });

  it("不同设备持有效锁时拒绝 lock_held_by_other（核心互斥）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams());
    const r = m.acquire(acquireParams({ deviceId: "dev2", runId: "runX" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("lock_held_by_other");
    expect(m.getLock("t1")?.deviceId).toBe("dev1"); // 原锁未被侵占
  });

  it("前锁已过期时其它设备可获取", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams({ ttlMs: 100 }));
    const r = m.acquire(acquireParams({ deviceId: "dev2", runId: "runX", now: T0 + 200 }));
    expect(r.ok).toBe(true);
    expect(m.getLock("t1")?.deviceId).toBe("dev2");
  });

  it("自定义 ttlMs 生效", () => {
    const m = new AiLockManager();
    const r = m.acquire(acquireParams({ ttlMs: 1234 }));
    if (r.ok) expect(r.lock.expiresAt).toBe(T0 + 1234);
  });
});

describe("AiLockManager — release 身份校验", () => {
  it("持有者（deviceId + runId 匹配）可释放", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams());
    expect(m.release("t1", "dev1", "run1", T0)).toBe(true);
    expect(m.getLock("t1")).toBeNull();
  });

  it("deviceId 不匹配拒绝释放（renderer 不可伪造）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams());
    expect(m.release("t1", "dev2", "run1", T0)).toBe(false);
    expect(m.getLock("t1")).not.toBeNull();
  });

  it("runId 不匹配拒绝释放（旧命令不可释放新锁）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams({ runId: "run2" }));
    expect(m.release("t1", "dev1", "run1", T0)).toBe(false);
    expect(m.getLock("t1")?.runId).toBe("run2");
  });

  it("无锁时释放返回 false", () => {
    const m = new AiLockManager();
    expect(m.release("t1", "dev1", "run1", T0)).toBe(false);
  });
});

describe("AiLockManager — cancel / revoke", () => {
  it("cancel 不校验身份（用户始终有权停止并接管）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams({ deviceId: "dev1", runId: "runA" }));
    const r = m.cancel("t1", T0);
    expect(r.cancelled).toBe(true);
    expect(r.runId).toBe("runA");
    expect(m.getLock("t1")).toBeNull();
  });

  it("cancel 无锁时返回 cancelled=false / runId=null", () => {
    const m = new AiLockManager();
    expect(m.cancel("t1", T0)).toEqual({ cancelled: false, runId: null });
  });

  it("revoke 强制撤销（设备接管场景）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams());
    expect(m.revoke("t1")).toBe(true);
    expect(m.getLock("t1")).toBeNull();
    expect(m.revoke("t1")).toBe(false); // 已无锁
  });
});

describe("AiLockManager — 查询与过期语义", () => {
  it("isLocked 过期即视为未持锁（无需先 cleanup）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams({ ttlMs: 100 }));
    expect(m.isLocked("t1", T0 + 50)).toBe(true);
    expect(m.isLocked("t1", T0 + 150)).toBe(false);
  });

  it("isInputBlocked 与 isLocked 一致（AI 持锁即阻止全部输入）", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams());
    expect(m.isInputBlocked("t1", "anyTab", T0)).toBe(true);
    m.release("t1", "dev1", "run1", T0);
    expect(m.isInputBlocked("t1", "anyTab", T0)).toBe(false);
  });

  it("cleanupExpired 只清过期锁并返回数量", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams({ threadId: "t1", ttlMs: 100 }));
    m.acquire(acquireParams({ threadId: "t2", ttlMs: 100_000 }));
    expect(m.cleanupExpired(T0 + 500)).toBe(1);
    expect(m.getLock("t1")).toBeNull();
    expect(m.getLock("t2")).not.toBeNull();
  });

  it("多 thread 锁相互独立", () => {
    const m = new AiLockManager();
    m.acquire(acquireParams({ threadId: "t1", deviceId: "d1" }));
    // 不同 thread 不受其它 thread 不同设备限制
    const r = m.acquire(acquireParams({ threadId: "t2", deviceId: "d2" }));
    expect(r.ok).toBe(true);
    expect(m.getAllLocks().length).toBe(2);
  });
});

describe("AiLockManager — 事件回调", () => {
  it("acquire 触发 onLocked（续期/替换也触发）", () => {
    const m = new AiLockManager();
    const cb = vi.fn();
    m.onLocked(cb);
    m.acquire(acquireParams());
    m.acquire(acquireParams({ runId: "run2" }));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("release/cancel/revoke/expired 各自携带正确 reason", () => {
    const m = new AiLockManager();
    const seen: string[] = [];
    m.onReleased((info) => seen.push(info.reason));

    m.acquire(acquireParams({ threadId: "a" }));
    m.release("a", "dev1", "run1", T0); // manual

    m.acquire(acquireParams({ threadId: "b" }));
    m.cancel("b", T0); // cancelled

    m.acquire(acquireParams({ threadId: "c" }));
    m.revoke("c"); // revoked

    m.acquire(acquireParams({ threadId: "d", ttlMs: 10 }));
    m.cleanupExpired(T0 + 100); // expired

    expect(seen).toEqual(["manual", "cancelled", "revoked", "expired"]);
  });

  it("取消订阅后不再收到回调", () => {
    const m = new AiLockManager();
    const cb = vi.fn();
    const off = m.onLocked(cb);
    m.acquire(acquireParams({ threadId: "a" }));
    off();
    m.acquire(acquireParams({ threadId: "b" }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("release 回调携带 threadId / runId / deviceId", () => {
    const m = new AiLockManager();
    const cb = vi.fn();
    m.onReleased(cb);
    m.acquire(acquireParams({ threadId: "t9", deviceId: "d9", runId: "r9" }));
    m.release("t9", "d9", "r9", T0);
    expect(cb).toHaveBeenCalledWith({
      threadId: "t9",
      runId: "r9",
      deviceId: "d9",
      reason: "manual",
    });
  });
});
