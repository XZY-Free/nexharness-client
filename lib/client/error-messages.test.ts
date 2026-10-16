import { describe, expect, it } from "vitest";
import type { ClientErrorBody } from "../client/types";
import { makeLocalVisibleError, toVisibleError } from "./error-messages";

/**
 * 错误映射是「内部错误码 → 员工可读文案」的唯一出口。
 * 这些用例锁定：未知码不泄露内部细节、requestId 保留但不展示、retryable 与契约一致。
 */
function errorBody(over: Partial<ClientErrorBody["error"]> = {}): ClientErrorBody {
  return {
    error: {
      code: "POLICY_BLOCKED",
      message: "internal detail that must not leak",
      request_id: "req-1",
      retryable: false,
      ...over,
    },
  };
}

describe("toVisibleError", () => {
  it("已知码映射到中文 title / description / recoveryAction", () => {
    const v = toVisibleError(errorBody({ code: "POLICY_BLOCKED" }));
    expect(v.title).toBe("策略已拦截");
    expect(v.recoveryAction).toBe("contact_admin");
    expect(v.code).toBe("POLICY_BLOCKED");
  });

  it("未知码回退 GENERIC_UNKNOWN（不泄露内部 code 文案）", () => {
    const v = toVisibleError(errorBody({ code: "SOME_INTERNAL_THING" }));
    expect(v.title).not.toContain("SOME_INTERNAL_THING");
    // code 保留原始值供诊断，但 title/description 是通用文案
    expect(v.code).toBe("SOME_INTERNAL_THING");
    expect(v.title.length).toBeGreaterThan(0);
  });

  it("retryable 直接采用服务端字段", () => {
    expect(toVisibleError(errorBody({ retryable: true })).retryable).toBe(true);
    expect(toVisibleError(errorBody({ retryable: false })).retryable).toBe(false);
  });

  it("requestId 保留供诊断", () => {
    expect(toVisibleError(errorBody({ request_id: "abc" })).requestId).toBe("abc");
  });

  it("request_id 缺失时为 null", () => {
    const v = toVisibleError(errorBody({ request_id: undefined as unknown as string }));
    expect(v.requestId).toBeNull();
  });

  it("不把服务端 message 直接透出给员工", () => {
    const v = toVisibleError(errorBody({ code: "POLICY_BLOCKED" }));
    expect(JSON.stringify(v)).not.toContain("internal detail that must not leak");
  });

  it("事件流相关码映射到 resnapshot / reconnect 恢复动作", () => {
    expect(toVisibleError(errorBody({ code: "EVENT_SEQUENCE_GAP" })).recoveryAction).toBe(
      "resnapshot",
    );
    expect(toVisibleError(errorBody({ code: "EVENT_CURSOR_EXPIRED" })).recoveryAction).toBe(
      "resnapshot",
    );
    expect(toVisibleError(errorBody({ code: "STREAM_BACKPRESSURE" })).recoveryAction).toBe(
      "reconnect",
    );
  });
});

describe("makeLocalVisibleError", () => {
  it("已知码使用映射文案", () => {
    const v = makeLocalVisibleError({ code: "EVENT_SEQUENCE_GAP" });
    expect(v.title).toBe("同步出现空缺");
    expect(v.recoveryAction).toBe("resnapshot");
  });

  it("retryable 默认 false，可显式覆盖", () => {
    expect(makeLocalVisibleError({ code: "X" }).retryable).toBe(false);
    expect(makeLocalVisibleError({ code: "X", retryable: true }).retryable).toBe(true);
  });

  it("requestId 默认 null，可显式传入", () => {
    expect(makeLocalVisibleError({ code: "X" }).requestId).toBeNull();
    expect(makeLocalVisibleError({ code: "X", requestId: "r" }).requestId).toBe("r");
  });

  it("未知码回退通用文案", () => {
    const v = makeLocalVisibleError({ code: "TOTALLY_UNKNOWN" });
    expect(v.code).toBe("TOTALLY_UNKNOWN");
    expect(v.title.length).toBeGreaterThan(0);
  });
});
