import { describe, expect, it } from "vitest";
import { canonicalSerialize, getEnvelopeSignPayload, getResultSignPayload } from "./rpc-envelope";

/**
 * canonicalSerialize 是签名一致性的根基：字段顺序不应影响签名，
 * 否则同一逻辑 payload 跨端/跨实现产生不同签名导致验签失败。
 */
describe("canonicalSerialize — 字段序无关", () => {
  it("同为 key 不同顺序产出相同结果（核心不变量）", () => {
    const a = canonicalSerialize({ b: 1, a: 2 });
    const b = canonicalSerialize({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("输出按 key 字母序", () => {
    expect(canonicalSerialize({ c: 1, a: 2, b: 3 })).toBe('{"a":2,"b":3,"c":1}');
  });

  it("嵌套对象递归排序", () => {
    const a = canonicalSerialize({ outer: { z: 1, a: 2 } });
    const b = canonicalSerialize({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
    expect(a).toContain('"a":2');
  });

  it("数组保持元素顺序（不排序）", () => {
    expect(canonicalSerialize({ arr: [3, 1, 2] })).toBe('{"arr":[3,1,2]}');
  });

  it("数组中的对象元素递归排序", () => {
    const a = canonicalSerialize({ arr: [{ b: 1, a: 2 }] });
    const b = canonicalSerialize({ arr: [{ a: 2, b: 1 }] });
    expect(a).toBe(b);
  });

  it("null 与基本类型原样", () => {
    expect(canonicalSerialize({ x: null })).toBe('{"x":null}');
    expect(canonicalSerialize({ n: 1, s: "a", b: true })).toBe('{"b":true,"n":1,"s":"a"}');
  });

  it("深层嵌套也稳定", () => {
    const shape = { z: { y: { x: [{ c: 1, a: 2 }] } }, a: 0 };
    const a = canonicalSerialize(shape);
    const b = canonicalSerialize({ a: 0, z: { y: { x: [{ a: 2, c: 1 }] } } });
    expect(a).toBe(b);
  });

  it("不同值产出不同结果（不会被误判等价）", () => {
    expect(canonicalSerialize({ a: 1 })).not.toBe(canonicalSerialize({ a: 2 }));
  });
});

describe("getEnvelopeSignPayload", () => {
  const envelope = {
    protocolVersion: 1,
    requestId: "req-1",
    deviceId: "dev-1",
    userId: "u-1",
    threadId: "t-1",
    tabId: null,
    runId: null,
    approvalId: null,
    command: "browser.getTabs",
    payload: { threadId: "t-1" },
    issuedAt: 1,
    expiresAt: 2,
    nonce: "n-1",
    signature: "SIG",
  };

  it("排除 signature 字段（签名字段本身不参与签名）", () => {
    const payload = getEnvelopeSignPayload(envelope as never);
    expect(payload).not.toContain("SIG");
    expect(payload).not.toContain("signature");
  });

  it("字段顺序无关（envelope 重排后 payload 相同）", () => {
    const reordered = {
      signature: "OTHER_SIG",
      nonce: "n-1",
      expiresAt: 2,
      issuedAt: 1,
      payload: { threadId: "t-1" },
      command: "browser.getTabs",
      approvalId: null,
      runId: null,
      tabId: null,
      threadId: "t-1",
      userId: "u-1",
      deviceId: "dev-1",
      requestId: "req-1",
      protocolVersion: 1,
    };
    expect(getEnvelopeSignPayload(reordered as never)).toBe(
      getEnvelopeSignPayload(envelope as never),
    );
  });

  it("任一业务字段变化则 payload 变化（防篡改不被察觉）", () => {
    const base = getEnvelopeSignPayload(envelope as never);
    expect(getEnvelopeSignPayload({ ...envelope, command: "browser.navigate" } as never)).not.toBe(
      base,
    );
    expect(getEnvelopeSignPayload({ ...envelope, deviceId: "other" } as never)).not.toBe(base);
  });
});

describe("getResultSignPayload", () => {
  it("排除 signature 字段", () => {
    const out = getResultSignPayload({
      requestId: "r",
      deviceId: "d",
      ok: true,
      signature: "S",
    } as never);
    expect(out).not.toContain("S");
    expect(out).not.toContain("signature");
  });
});
