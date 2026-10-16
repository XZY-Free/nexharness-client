import { describe, expect, it, vi } from "vitest";
import { ConnectionStateMachine } from "./connection-state";

/**
 * 连接状态机决定「何时允许发 RPC」——未认证就发 RPC 是安全漏洞。
 * 这些用例锁定：状态转换表、canSendRpc 严格性、非法转换抛错、订阅通知。
 */
describe("ConnectionStateMachine — 合法转换路径", () => {
  it("connect → connecting → connected → authenticated（完整上线）", () => {
    const m = new ConnectionStateMachine();
    expect(m.getState()).toBe("disconnected");
    m.transition({ type: "connect" });
    expect(m.getState()).toBe("connecting");
    m.transition({ type: "connected" });
    expect(m.getState()).toBe("connected");
    m.transition({ type: "authenticated" });
    expect(m.getState()).toBe("authenticated");
  });

  it("disconnect 从任意在线态回到 disconnected", () => {
    for (const path of [
      ["connect", "connected"],
      ["connect", "connected", "authenticated"],
    ] as const) {
      const m = new ConnectionStateMachine();
      for (const e of path) m.transition({ type: e });
      m.transition({ type: "disconnect" });
      expect(m.getState()).toBe("disconnected");
    }
  });

  it("重连路径：disconnected → reconnecting → connected/ disconnected", () => {
    const ok = new ConnectionStateMachine();
    ok.transition({ type: "reconnect" });
    expect(ok.getState()).toBe("reconnecting");
    ok.transition({ type: "reconnect_success" });
    expect(ok.getState()).toBe("connected");

    const fail = new ConnectionStateMachine();
    fail.transition({ type: "reconnect" });
    fail.transition({ type: "reconnect_fail" });
    expect(fail.getState()).toBe("disconnected");
  });

  it("revoked / protocol_mismatch 终态可由 disconnect 复位", () => {
    const revoked = new ConnectionStateMachine();
    revoked.transition({ type: "connect" });
    revoked.transition({ type: "connected" });
    revoked.transition({ type: "revoke" });
    expect(revoked.getState()).toBe("revoked");
    revoked.transition({ type: "disconnect" });
    expect(revoked.getState()).toBe("disconnected");

    const mism = new ConnectionStateMachine();
    mism.transition({ type: "connect" });
    mism.transition({ type: "connected" });
    mism.transition({ type: "protocol_mismatch" });
    expect(mism.getState()).toBe("protocol_mismatch");
  });
});

describe("ConnectionStateMachine — 非法转换", () => {
  it("disconnected 下发 RPC 相关事件抛错", () => {
    const m = new ConnectionStateMachine();
    expect(() => m.transition({ type: "authenticated" })).toThrow(/非法状态转换/);
    expect(() => m.transition({ type: "revoke" })).toThrow();
  });

  it("connecting 直接 authenticated 抛错（必须先 connected）", () => {
    const m = new ConnectionStateMachine();
    m.transition({ type: "connect" });
    expect(() => m.transition({ type: "authenticated" })).toThrow();
  });

  it("抛错后状态保持不变（不半途改状态）", () => {
    const m = new ConnectionStateMachine();
    m.transition({ type: "connect" });
    try {
      m.transition({ type: "authenticated" });
    } catch {
      /* expected */
    }
    expect(m.getState()).toBe("connecting");
  });

  it("authenticated 态不接受 connected / connect 重复事件", () => {
    const m = new ConnectionStateMachine();
    m.transition({ type: "connect" });
    m.transition({ type: "connected" });
    m.transition({ type: "authenticated" });
    expect(() => m.transition({ type: "connected" })).toThrow();
    expect(() => m.transition({ type: "connect" })).toThrow();
  });

  it("revoked 态不接受 authenticated（凭据已失效）", () => {
    const m = new ConnectionStateMachine();
    m.transition({ type: "connect" });
    m.transition({ type: "connected" });
    m.transition({ type: "revoke" });
    expect(() => m.transition({ type: "authenticated" })).toThrow();
  });
});

describe("ConnectionStateMachine — canSendRpc / isOnline", () => {
  it("只有 authenticated 才能发 RPC（安全边界）", () => {
    const m = new ConnectionStateMachine();
    expect(m.canSendRpc()).toBe(false); // disconnected
    m.transition({ type: "connect" });
    expect(m.canSendRpc()).toBe(false); // connecting
    m.transition({ type: "connected" });
    expect(m.canSendRpc()).toBe(false); // connected 但未认证
    m.transition({ type: "authenticated" });
    expect(m.canSendRpc()).toBe(true); // 只有这里
  });

  it("isOnline 覆盖 connected + authenticated，不含 connecting", () => {
    const m = new ConnectionStateMachine();
    expect(m.isOnline()).toBe(false);
    m.transition({ type: "connect" });
    expect(m.isOnline()).toBe(false); // connecting 不算在线
    m.transition({ type: "connected" });
    expect(m.isOnline()).toBe(true);
    m.transition({ type: "authenticated" });
    expect(m.isOnline()).toBe(true);
  });

  it("revoked / protocol_mismatch 态不可发 RPC 且不在线", () => {
    const m = new ConnectionStateMachine();
    m.transition({ type: "connect" });
    m.transition({ type: "connected" });
    m.transition({ type: "revoke" });
    expect(m.canSendRpc()).toBe(false);
    expect(m.isOnline()).toBe(false);
  });
});

describe("ConnectionStateMachine — 订阅", () => {
  it("合法转换通知订阅者，携带 (新状态, 旧状态)", () => {
    const m = new ConnectionStateMachine();
    const cb = vi.fn();
    m.subscribe(cb);
    m.transition({ type: "connect" });
    expect(cb).toHaveBeenCalledWith("connecting", "disconnected");
  });

  it("非法转换不通知订阅者", () => {
    const m = new ConnectionStateMachine();
    const cb = vi.fn();
    m.subscribe(cb);
    expect(() => m.transition({ type: "authenticated" })).toThrow();
    expect(cb).not.toHaveBeenCalled();
  });

  it("取消订阅后不再收到通知", () => {
    const m = new ConnectionStateMachine();
    const cb = vi.fn();
    const off = m.subscribe(cb);
    m.transition({ type: "connect" });
    off();
    m.transition({ type: "connected" });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("多个订阅者都收到通知", () => {
    const m = new ConnectionStateMachine();
    const a = vi.fn();
    const b = vi.fn();
    m.subscribe(a);
    m.subscribe(b);
    m.transition({ type: "connect" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
