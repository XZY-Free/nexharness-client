import { describe, expect, it } from "vitest";
import { DesktopErrorCode, desktopError, isDesktopError } from "./errors";

/**
 * Desktop 稳定错误码是 IPC/RPC 错误的契约（前端按 code 分支，不按 message）。
 * 这些用例锁定：码值稳定（不可改名）、错误体形状、类型守卫。
 */
describe("DesktopErrorCode", () => {
  it("码值为小写下划线（命名规则 <scope>_<reason>）", () => {
    for (const v of Object.values(DesktopErrorCode)) {
      expect(v).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("码值唯一（无重复）", () => {
    const values = Object.values(DesktopErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });

  it("关键码值稳定（前端依赖，改名即破坏契约）", () => {
    expect(DesktopErrorCode.DESKTOP_UNAVAILABLE).toBe("desktop_unavailable");
    expect(DesktopErrorCode.RPC_INVALID_SIGNATURE).toBe("rpc_invalid_signature");
    expect(DesktopErrorCode.LEASE_HELD_BY_OTHER).toBe("lease_held_by_other");
    expect(DesktopErrorCode.APPROVAL_REQUIRED).toBe("approval_required");
    expect(DesktopErrorCode.URL_BLOCKED).toBe("url_blocked");
    expect(DesktopErrorCode.ORIGIN_REJECTED).toBe("origin_rejected");
  });
});

describe("desktopError", () => {
  it("构造 ok:false 的错误体", () => {
    const e = desktopError(DesktopErrorCode.TAB_NOT_FOUND, "no tab");
    expect(e.ok).toBe(false);
    expect(e.code).toBe("tab_not_found");
    expect(e.message).toBe("no tab");
  });

  it("detail 可选", () => {
    expect(desktopError(DesktopErrorCode.BROWSER_INTERNAL, "x").detail).toBeUndefined();
    expect(desktopError(DesktopErrorCode.BROWSER_INTERNAL, "x", { ctx: 1 }).detail).toEqual({
      ctx: 1,
    });
  });
});

describe("isDesktopError", () => {
  it("识别合法 DesktopError", () => {
    expect(isDesktopError(desktopError(DesktopErrorCode.RPC_TIMEOUT, "t"))).toBe(true);
  });

  it("拒绝非对象 / null / ok!=false / 缺字段", () => {
    expect(isDesktopError(null)).toBe(false);
    expect(isDesktopError("x")).toBe(false);
    expect(isDesktopError({ ok: true, code: "c", message: "m" })).toBe(false);
    expect(isDesktopError({ ok: false, code: "c" })).toBe(false);
    expect(isDesktopError({ ok: false, message: "m" })).toBe(false);
    expect(isDesktopError({})).toBe(false);
  });

  it("成功结果（ok:true）不被误判为错误", () => {
    expect(isDesktopError({ ok: true, result: 1 })).toBe(false);
  });
});
