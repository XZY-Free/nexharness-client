import { describe, expect, it } from "vitest";
import { API_ERROR_CODES, type ApiErrorCode, errorDefinition } from "./error-codes";

/**
 * error-codes 是错误响应的 HTTP 状态与 retryable 的权威目录（fail-closed）。
 * 这些用例锁定：未知码抛错（不凭空返回）、每个码的 http/retryable 类型合法。
 */
describe("API_ERROR_CODES 目录", () => {
  it("每个码都有 http(正整数) + retryable(bool)", () => {
    for (const [code, def] of Object.entries(API_ERROR_CODES)) {
      expect(Number.isInteger(def.http), `${code} http 应为整数`).toBe(true);
      expect(def.http).toBeGreaterThanOrEqual(400);
      expect(def.http).toBeLessThan(600);
      expect(typeof def.retryable).toBe("boolean");
    }
  });

  it("码名全大写（命名一致性）", () => {
    for (const code of Object.keys(API_ERROR_CODES)) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("包含关键码（迁移后新增的通用码）", () => {
    for (const c of [
      "AUTHENTICATION_REQUIRED",
      "ACCESS_DENIED",
      "RESOURCE_NOT_FOUND",
      "REQUEST_SCHEMA_INVALID",
      "ETAG_MISMATCH",
      "INTERNAL_ERROR",
      "METHOD_NOT_ALLOWED",
      "PAYLOAD_TOO_LARGE",
      "NOT_OWNER",
      "WORKSPACE_REVISION_CONFLICT",
      "SKILL_NOT_FOUND",
      "DEVICE_NOT_FOUND",
    ] as ApiErrorCode[]) {
      expect(API_ERROR_CODES[c]).toBeDefined();
    }
  });

  it("含信封统一迁移的通用码 http 状态正确", () => {
    expect(API_ERROR_CODES.INVALID_REQUEST.http).toBe(400);
    expect(API_ERROR_CODES.MISSING_REQUIRED_FIELD.http).toBe(400);
    expect(API_ERROR_CODES.METHOD_NOT_ALLOWED.http).toBe(405);
    expect(API_ERROR_CODES.NAME_CONFLICT.http).toBe(409);
    expect(API_ERROR_CODES.VERSION_CONFLICT.http).toBe(409);
    expect(API_ERROR_CODES.PAYLOAD_TOO_LARGE.http).toBe(413);
    expect(API_ERROR_CODES.INTERNAL_ERROR.http).toBe(500);
  });

  it("4xx 分类正确（401/403/404/409/412/413/429）", () => {
    expect(API_ERROR_CODES.AUTHENTICATION_REQUIRED.http).toBe(401);
    expect(API_ERROR_CODES.ACCESS_DENIED.http).toBe(403);
    expect(API_ERROR_CODES.RESOURCE_NOT_FOUND.http).toBe(404);
    expect(API_ERROR_CODES.ETAG_MISMATCH.http).toBe(412);
    expect(API_ERROR_CODES.PAYLOAD_TOO_LARGE.http).toBe(413);
    expect(API_ERROR_CODES.RATE_LIMITED.http).toBe(429);
  });

  it("5xx 分类正确", () => {
    expect(API_ERROR_CODES.INTERNAL_ERROR.http).toBe(500);
    expect(API_ERROR_CODES.RUNTIME_UNAVAILABLE.http).toBe(503);
  });
});

describe("errorDefinition — fail-closed", () => {
  it("已知码返回定义", () => {
    expect(errorDefinition("AUTHENTICATION_REQUIRED").http).toBe(401);
    expect(errorDefinition("RESOURCE_NOT_FOUND").retryable).toBe(false);
  });

  it("未知码抛错（禁止运行时凭空调用）", () => {
    expect(() => errorDefinition("NOT_A_REAL_CODE")).toThrow(/unknown error code/);
    expect(() => errorDefinition("")).toThrow();
    expect(() => errorDefinition("auth_required")).toThrow(); // 小写不算
  });

  it("返回的定义与目录一致", () => {
    for (const code of Object.keys(API_ERROR_CODES) as ApiErrorCode[]) {
      expect(errorDefinition(code)).toEqual(API_ERROR_CODES[code]);
    }
  });
});

describe("retryable 语义抽样", () => {
  it("可重试类（429/503/ETAG 冲突）为 true", () => {
    expect(API_ERROR_CODES.RATE_LIMITED.retryable).toBe(true);
    expect(API_ERROR_CODES.RUNTIME_UNAVAILABLE.retryable).toBe(true);
    expect(API_ERROR_CODES.ETAG_MISMATCH.retryable).toBe(true);
  });

  it("不可重试类（鉴权/权限/404/参数）为 false", () => {
    expect(API_ERROR_CODES.AUTHENTICATION_REQUIRED.retryable).toBe(false);
    expect(API_ERROR_CODES.ACCESS_DENIED.retryable).toBe(false);
    expect(API_ERROR_CODES.RESOURCE_NOT_FOUND.retryable).toBe(false);
    expect(API_ERROR_CODES.REQUEST_SCHEMA_INVALID.retryable).toBe(false);
  });
});
