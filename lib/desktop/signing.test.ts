import { describe, expect, it } from "vitest";
import {
  AUTH_SIGN_DOMAIN,
  generateDeviceKeyPair,
  generateNonce,
  generateRequestId,
  getAuthSignPayload,
  signData,
  verifySignature,
} from "./signing";

/**
 * signing 是设备身份与 RPC 完整性的密码学根。
 * 这些用例锁定：签名自洽、篡改必拒、跨租户/跨用途不可重放、payload 抗拼接碰撞。
 */
describe("generateDeviceKeyPair + sign/verify", () => {
  it("生成的密钥对可自洽签名验签", () => {
    const pair = generateDeviceKeyPair();
    const data = "hello";
    const sig = signData(data, pair.privateKeyBase64);
    expect(verifySignature(data, sig, pair.publicKeyBase64)).toBe(true);
  });

  it("公钥为 raw 32 字节 base64", () => {
    const pair = generateDeviceKeyPair();
    expect(Buffer.from(pair.publicKeyBase64, "base64").length).toBe(32);
  });

  it("每次生成不同密钥对（无硬编码）", () => {
    expect(generateDeviceKeyPair().publicKeyBase64).not.toBe(
      generateDeviceKeyPair().publicKeyBase64,
    );
  });

  it("数据被篡改后验签失败", () => {
    const pair = generateDeviceKeyPair();
    const sig = signData("original", pair.privateKeyBase64);
    expect(verifySignature("tampered", sig, pair.publicKeyBase64)).toBe(false);
  });

  it("用别人的公钥验签失败", () => {
    const a = generateDeviceKeyPair();
    const b = generateDeviceKeyPair();
    const sig = signData("m", a.privateKeyBase64);
    expect(verifySignature("m", sig, b.publicKeyBase64)).toBe(false);
  });

  it("非法私钥 / 公钥 / 签名抛错（fail-closed）", () => {
    const pair = generateDeviceKeyPair();
    expect(() => signData("m", "")).toThrow();
    expect(() => signData("m", "not-base64-!!")).toThrow();
    expect(() => verifySignature("m", "sig", "")).toThrow();
    expect(() => verifySignature("m", "", pair.publicKeyBase64)).toThrow();
    expect(() => verifySignature("m", "not base64!", pair.publicKeyBase64)).toThrow();
  });

  it("公钥长度非 32 字节时验签抛错", () => {
    const pair = generateDeviceKeyPair();
    const sig = signData("m", pair.privateKeyBase64);
    const shortKey = Buffer.from("1234567890").toString("base64");
    expect(() => verifySignature("m", sig, shortKey)).toThrow();
  });

  it("signData 接受 Buffer 与 string（同一内容等价）", () => {
    const pair = generateDeviceKeyPair();
    const sigA = signData("abc", pair.privateKeyBase64);
    const sigB = signData(Buffer.from("abc", "utf8"), pair.privateKeyBase64);
    expect(sigA).toBe(sigB);
  });
});

describe("getAuthSignPayload — 抗重放与抗碰撞", () => {
  it("包含 domain separator", () => {
    const p = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c" });
    expect(p).toContain(AUTH_SIGN_DOMAIN);
  });

  it("相同输入产出相同 payload（确定性）", () => {
    const a = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c" });
    const b = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c" });
    expect(a).toBe(b);
  });

  it("跨租户产生不同 payload（签名不可跨租户重放）", () => {
    const a = getAuthSignPayload({ tenantId: "t1", deviceKey: "d", challenge: "c" });
    const b = getAuthSignPayload({ tenantId: "t2", deviceKey: "d", challenge: "c" });
    expect(a).not.toBe(b);
  });

  it("不同 challenge 产生不同 payload（旧挑战签名不可重放）", () => {
    const a = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c1" });
    const b = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c2" });
    expect(a).not.toBe(b);
  });

  it("字段含分隔符/引号不会拼接碰撞（JSON 数组编码免疫）", () => {
    // 若用朴素字符串拼接，下面两组可能碰撞
    const a = getAuthSignPayload({ tenantId: "a", deviceKey: "b,c", challenge: "d" });
    const b = getAuthSignPayload({ tenantId: "a,b", deviceKey: "c", challenge: "d" });
    expect(a).not.toBe(b);

    const c = getAuthSignPayload({ tenantId: 'x"', deviceKey: "y", challenge: "z" });
    const d = getAuthSignPayload({ tenantId: "x", deviceKey: '"y', challenge: "z" });
    expect(c).not.toBe(d);
  });

  it("空字段抛错（fail-closed）", () => {
    expect(() => getAuthSignPayload({ tenantId: "", deviceKey: "d", challenge: "c" })).toThrow();
    expect(() => getAuthSignPayload({ tenantId: "t", deviceKey: "", challenge: "c" })).toThrow();
    expect(() => getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "" })).toThrow();
  });

  it("端到端：challenge 签名验签成功，篡改 challenge 后失败", () => {
    const pair = generateDeviceKeyPair();
    const payload = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c" });
    const sig = signData(payload, pair.privateKeyBase64);
    expect(verifySignature(payload, sig, pair.publicKeyBase64)).toBe(true);
    const tampered = getAuthSignPayload({ tenantId: "t", deviceKey: "d", challenge: "c2" });
    expect(verifySignature(tampered, sig, pair.publicKeyBase64)).toBe(false);
  });
});

describe("generateNonce / generateRequestId", () => {
  it("产出非空且高度唯一", () => {
    const nonces = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(nonces.size).toBe(200);
    expect([...nonces].every((n) => n.length > 0)).toBe(true);
  });

  it("requestId 与 nonce 各自唯一", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateRequestId()));
    expect(ids.size).toBe(200);
  });
});
