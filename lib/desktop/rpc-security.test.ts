import { describe, expect, it } from "vitest";
import { getEnvelopeSignPayload } from "./rpc-envelope";
import { NonceDeduplicator, validateRpcEnvelope } from "./rpc-security";
import { generateDeviceKeyPair, signData } from "./signing";

describe("NonceDeduplicator", () => {
  it("首次见到 nonce 返回 true，重复返回 false", () => {
    const d = new NonceDeduplicator();
    const exp = Date.now() + 60_000;
    expect(d.checkAndAdd("n1", exp)).toBe(true);
    expect(d.checkAndAdd("n1", exp)).toBe(false);
    expect(d.checkAndAdd("n2", exp)).toBe(true);
    expect(d.size()).toBe(2);
  });

  it("超容量淘汰最旧条目（Map 插入序）", () => {
    const d = new NonceDeduplicator(2);
    const exp = Date.now() + 60_000;
    d.checkAndAdd("a", exp);
    d.checkAndAdd("b", exp);
    d.checkAndAdd("c", exp); // 淘汰 a
    expect(d.size()).toBe(2);
    expect(d.checkAndAdd("a", exp)).toBe(true); // a 已被淘汰
  });

  it("cleanup 清理过期 nonce", () => {
    const d = new NonceDeduplicator();
    const now = Date.now();
    d.checkAndAdd("old", now - 1000);
    d.checkAndAdd("fresh", now + 60_000);
    expect(d.cleanup(now)).toBe(1);
    expect(d.size()).toBe(1);
  });
});

describe("validateRpcEnvelope", () => {
  const deviceId = "device-1";
  const userId = "user-1";
  const pair = generateDeviceKeyPair();
  const publicKey = pair.publicKeyBase64;

  function makeEnvelope(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    const envelope = {
      protocolVersion: 1,
      requestId: "req-1",
      deviceId,
      userId,
      threadId: "thread-1",
      tabId: null,
      runId: null,
      approvalId: null,
      command: "browser.getTabs",
      payload: { threadId: "thread-1" },
      issuedAt: now,
      expiresAt: now + 60_000,
      nonce: "nonce-1",
      signature: "",
      ...overrides,
    } as Record<string, unknown>;
    // 签名覆盖除 signature 外的规范序列化
    const payload = getEnvelopeSignPayload(envelope as never);
    envelope.signature = signData(payload, pair.privateKeyBase64);
    return envelope;
  }

  it("字段齐全、签名有效、命令合法时通过", () => {
    const env = makeEnvelope();
    const result = validateRpcEnvelope(env, deviceId, userId, publicKey, Date.now());
    expect(result.ok).toBe(true);
  });

  it("schema 不合法（缺字段）时拒绝为 rpc_invalid_payload", () => {
    const env = makeEnvelope({ requestId: "" });
    const result = validateRpcEnvelope(env, deviceId, userId, publicKey, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rpc_invalid_payload");
  });

  it("协议版本不兼容时拒绝", () => {
    const env = makeEnvelope({ protocolVersion: 99 });
    const result = validateRpcEnvelope(env, deviceId, userId, publicKey, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("protocol_mismatch");
  });

  it("deviceId 不匹配时拒绝为 unauthorized", () => {
    const env = makeEnvelope();
    const result = validateRpcEnvelope(env, "other-device", userId, publicKey, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
  });

  it("userId 不匹配时拒绝（expectedUserId 非 null）", () => {
    const env = makeEnvelope();
    const result = validateRpcEnvelope(env, deviceId, "other-user", publicKey, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unauthorized");
  });

  it("过期请求拒绝为 rpc_timeout", () => {
    const env = makeEnvelope();
    const result = validateRpcEnvelope(env, deviceId, userId, publicKey, Date.now() + 999_999);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rpc_timeout");
  });

  it("签名被篡改时拒绝为 rpc_invalid_signature", () => {
    const env = makeEnvelope();
    // 篡改 payload，签名不再匹配
    (env as { payload: unknown }).payload = { threadId: "tampered" };
    const result = validateRpcEnvelope(env, deviceId, userId, publicKey, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rpc_invalid_signature");
  });

  it("命令合法但 payload 不符合 schema 时拒绝为 rpc_invalid_payload", () => {
    const env = makeEnvelope({ payload: { wrongField: 1 } });
    // 重新签名，使失败原因落在 payload schema 而非签名
    const payload = getEnvelopeSignPayload(env as never);
    (env as { signature: string }).signature = signData(payload, pair.privateKeyBase64);
    const result = validateRpcEnvelope(env, deviceId, userId, publicKey, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rpc_invalid_payload");
  });

  it("未知命令被白名单拦截", () => {
    const env = makeEnvelope({ command: "browser.evilCommand" });
    const result = validateRpcEnvelope(env, deviceId, userId, publicKey, Date.now());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown_command");
  });
});
