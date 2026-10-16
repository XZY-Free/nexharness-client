import { describe, expect, it } from "vitest";
import {
  authMessageSchema,
  noControlChars,
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
} from "./bridge-messages";
import { PROTOCOL_VERSION } from "./protocol";

/**
 * Bridge 协议解析是 Desktop↔Server 的信任边界（非法消息必须拒绝，不能半解析）。
 * 这些用例锁定：类型判别、字段校验、控制字符拒绝（防签名 payload 碰撞）。
 */
describe("parseServerMessage", () => {
  it("合法 challenge 通过", () => {
    const r = parseServerMessage({
      type: "challenge",
      challenge: "abc",
      serverPublicKey: "key",
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.type).toBe("challenge");
  });

  it("协议版本不匹配拒绝", () => {
    const r = parseServerMessage({
      type: "challenge",
      challenge: "abc",
      serverPublicKey: "key",
      protocolVersion: 999,
    });
    expect(r.ok).toBe(false);
  });

  it("未知 type 拒绝", () => {
    expect(parseServerMessage({ type: "evil_command" }).ok).toBe(false);
    expect(parseServerMessage({ type: "" }).ok).toBe(false);
  });

  it("缺 type / 非对象拒绝", () => {
    expect(parseServerMessage({}).ok).toBe(false);
    expect(parseServerMessage(null).ok).toBe(false);
    expect(parseServerMessage("str").ok).toBe(false);
    expect(parseServerMessage([1, 2]).ok).toBe(false);
  });

  it("合法 auth_ok / auth_failed / heartbeat 通过", () => {
    expect(
      parseServerMessage({
        type: "auth_ok",
        protocolVersion: PROTOCOL_VERSION,
        deviceRecordId: "d",
        serverTime: 1,
      }).ok,
    ).toBe(true);
    expect(parseServerMessage({ type: "auth_failed", error: { code: "x", message: "y" } }).ok).toBe(
      true,
    );
    expect(parseServerMessage({ type: "heartbeat", timestamp: 1 }).ok).toBe(true);
  });

  it("空字符串必填字段拒绝", () => {
    expect(
      parseServerMessage({
        type: "challenge",
        challenge: "",
        serverPublicKey: "key",
        protocolVersion: PROTOCOL_VERSION,
      }).ok,
    ).toBe(false);
  });

  it("serverTime 非正整数拒绝", () => {
    expect(
      parseServerMessage({
        type: "auth_ok",
        protocolVersion: PROTOCOL_VERSION,
        deviceRecordId: "d",
        serverTime: 0,
      }).ok,
    ).toBe(false);
    expect(
      parseServerMessage({
        type: "auth_ok",
        protocolVersion: PROTOCOL_VERSION,
        deviceRecordId: "d",
        serverTime: -1,
      }).ok,
    ).toBe(false);
    expect(
      parseServerMessage({
        type: "auth_ok",
        protocolVersion: PROTOCOL_VERSION,
        deviceRecordId: "d",
        serverTime: 1.5,
      }).ok,
    ).toBe(false);
  });
});

describe("parseClientMessage", () => {
  const validAuthMessage = {
    type: "auth" as const,
    deviceId: "d1",
    signature: "sig",
    version: "1.0.0",
    name: "My Mac",
    tenantId: "t1",
    protocolVersion: PROTOCOL_VERSION,
  };

  it("合法 auth 消息通过", () => {
    expect(parseClientMessage(validAuthMessage).ok).toBe(true);
  });

  it("未知 type / 非对象拒绝", () => {
    expect(parseClientMessage({ type: "nope" }).ok).toBe(false);
    expect(parseClientMessage(null).ok).toBe(false);
    expect(parseClientMessage([]).ok).toBe(false);
  });

  it("auth 缺签名字段拒绝", () => {
    const { signature: _sig, ...withoutSig } = validAuthMessage;
    void _sig;
    expect(parseClientMessage(withoutSig).ok).toBe(false);
  });

  it("auth 协议版本不匹配拒绝", () => {
    expect(parseClientMessage({ ...validAuthMessage, protocolVersion: 999 }).ok).toBe(false);
  });
});

describe("noControlChars — 防签名 payload 碰撞", () => {
  it("普通字符串通过", () => {
    expect(noControlChars.safeParse("abc-123").success).toBe(true);
  });

  it("拒绝换行 / 制表 / NUL / DEL 等控制字符", () => {
    for (const s of ["a\nb", "a\tb", "a\rb", "\u0000", "a\u007fb", "a\u001fb"]) {
      expect(noControlChars.safeParse(s).success).toBe(false);
    }
  });

  it("拒绝空串", () => {
    expect(noControlChars.safeParse("").success).toBe(false);
  });

  it("authMessageSchema 对含控制字符的认证字段拒绝", () => {
    const r = authMessageSchema.safeParse({
      type: "auth",
      tenantId: "t\nid",
      deviceId: "d",
      challenge: "c",
      signature: "s",
    });
    expect(r.success).toBe(false);
  });
});

describe("serializeMessage", () => {
  it("合法消息序列化为 JSON 字符串并可被解析回来", () => {
    const msg = {
      type: "heartbeat_ack" as const,
      timestamp: 123,
    };
    const s = serializeMessage(msg as never);
    expect(typeof s).toBe("string");
    const parsed = JSON.parse(s);
    expect(parsed.type).toBe("heartbeat_ack");
  });

  it("序列化结果可被 parseClientMessage 接受（round-trip）", () => {
    const msg = {
      type: "auth" as const,
      deviceId: "d1",
      signature: "sig",
      version: "1.0.0",
      name: "My Mac",
      tenantId: "t1",
      protocolVersion: PROTOCOL_VERSION,
    };
    const s = serializeMessage(msg as never);
    expect(parseClientMessage(JSON.parse(s)).ok).toBe(true);
  });
});
