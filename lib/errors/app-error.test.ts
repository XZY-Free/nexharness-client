import type { ClientVisibleError } from "@/lib/client/types";
import { ControlPlaneRequestError } from "@/lib/control-plane-client/http-client";
import { describe, expect, it } from "vitest";
import {
  AppError,
  NETWORK_ERROR_CODE,
  UNKNOWN_ERROR_CODE,
  fromDesktopErrorLike,
  fromNetworkFailure,
  fromVisibleError,
  isAppError,
  toAppError,
} from "./app-error";

/**
 * AppError 是四套错误表示的**统一收口**。
 * 这些用例锁定：继承 Error（栈/cause 不丢）、归一幂等、未知值兜底不抛、四类转换正确。
 */
describe("AppError 构造", () => {
  it("是 Error 的子类（栈可追踪）", () => {
    const e = new AppError({ code: "X", message: "boom" });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AppError);
    expect(e.name).toBe("AppError");
    expect(e.message).toBe("boom");
    expect(typeof e.stack).toBe("string");
  });

  it("可重试默认 false（安全默认，不鼓励盲目重试）", () => {
    expect(new AppError({ code: "X", message: "m" }).retryable).toBe(false);
  });

  it("requestId 默认 null", () => {
    expect(new AppError({ code: "X", message: "m" }).requestId).toBeNull();
  });

  it("保留 cause 链", () => {
    const root = new Error("root");
    const e = new AppError({ code: "X", message: "m", cause: root });
    expect(e.cause).toBe(root);
  });

  it("details 可选", () => {
    expect(new AppError({ code: "X", message: "m" }).details).toBeUndefined();
    expect(new AppError({ code: "X", message: "m", details: { a: 1 } }).details).toEqual({ a: 1 });
  });
});

describe("isAppError", () => {
  it("识别 AppError 与子类", () => {
    expect(isAppError(new AppError({ code: "X", message: "m" }))).toBe(true);
    expect(isAppError(new ControlPlaneRequestError("RATE_LIMITED", "m", "r", true, 429))).toBe(
      true,
    );
  });

  it("拒绝普通 Error / 对象 / 原始值", () => {
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError({ code: "X", message: "m" })).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("x")).toBe(false);
  });
});

describe("toAppError — 归一", () => {
  it("已是 AppError 时幂等（返回同一实例）", () => {
    const e = new AppError({ code: "X", message: "m" });
    expect(toAppError(e)).toBe(e);
  });

  it("原生 Error → UNKNOWN_ERROR，保留 cause 与 message", () => {
    const src = new Error("原生失败");
    const e = toAppError(src);
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe(UNKNOWN_ERROR_CODE);
    expect(e.message).toBe("原生失败");
    expect(e.cause).toBe(src);
  });

  it("原生 Error 带 code 字段时采用该 code（Node err.code）", () => {
    const src = Object.assign(new Error("enoent"), { code: "ENOENT" });
    expect(toAppError(src).code).toBe("ENOENT");
  });

  it("ControlPlaneRequestError（子类）被幂等识别，不丢失 status", () => {
    const src = new ControlPlaneRequestError("RATE_LIMITED", "太快", "req-1", true, 429);
    const e = toAppError(src);
    expect(e).toBe(src); // 已是 AppError 子类 → 原样返回
    expect((e as ControlPlaneRequestError).status).toBe(429);
  });

  it("类错误对象（含 code+message）→ 采用其字段", () => {
    const e = toAppError({
      code: "TAB_NOT_FOUND",
      message: "tab 不存在",
      retryable: true,
      requestId: "r-9",
      details: { tabId: "t1" },
    });
    expect(e.code).toBe("TAB_NOT_FOUND");
    expect(e.retryable).toBe(true);
    expect(e.requestId).toBe("r-9");
    expect(e.details).toEqual({ tabId: "t1" });
  });

  it("字符串 / 数字 / null / undefined 兜底为 UNKNOWN_ERROR（不抛）", () => {
    for (const v of ["字符串错误", 42, null, undefined, [], true]) {
      const e = toAppError(v);
      expect(e).toBeInstanceOf(AppError);
      expect(e.code).toBe(UNKNOWN_ERROR_CODE);
    }
    expect(toAppError("字符串错误").message).toBe("字符串错误");
    expect(toAppError(null).message).toBe("发生未知错误");
  });

  it("永不抛出（收口函数不能自己失败）", () => {
    const weird = {
      get code() {
        throw new Error("getter 爆炸");
      },
    };
    // 即便属性 getter 抛错，也不应让 toAppError 冒泡（形状守卫用 typeof 读取，
    // 若实现改为直接访问可能抛出 —— 此用例固化"不得抛出"契约）
    expect(() => {
      try {
        toAppError(weird);
      } catch {
        // 若未来实现改为会抛，这里会暴露
        throw new Error("toAppError 不应抛出");
      }
    }).not.toThrow();
  });
});

describe("fromNetworkFailure", () => {
  it("固定 NETWORK_ERROR 且可重试", () => {
    const e = fromNetworkFailure(new Error("ECONNREFUSED"));
    expect(e.code).toBe(NETWORK_ERROR_CODE);
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("ECONNREFUSED");
  });

  it("非 Error 输入也能处理", () => {
    expect(fromNetworkFailure("timeout").message).toContain("timeout");
  });
});

describe("fromDesktopErrorLike", () => {
  it("保留小写下划线码（Desktop 命名空间）", () => {
    const e = fromDesktopErrorLike({ code: "tab_not_found", message: "tab 不存在" });
    expect(e.code).toBe("tab_not_found");
    expect(e.retryable).toBe(false);
  });

  it("detail 为对象时进 details", () => {
    const e = fromDesktopErrorLike({
      code: "rpc_invalid_payload",
      message: "缺字段",
      detail: { field: "tabId" },
    });
    expect(e.details).toEqual({ field: "tabId" });
  });

  it("detail 为非对象时忽略", () => {
    expect(
      fromDesktopErrorLike({ code: "x", message: "m", detail: "str" }).details,
    ).toBeUndefined();
  });
});

describe("fromVisibleError", () => {
  it("用 title 作 message（信息量高且不泄露内部细节）", () => {
    const visible: ClientVisibleError = {
      code: "ACCESS_DENIED",
      title: "没有访问权限",
      description: "当前账号无法访问该资源。",
      retryable: false,
      recoveryAction: "contact_admin",
      requestId: "r-1",
    };
    const e = fromVisibleError(visible);
    expect(e.code).toBe("ACCESS_DENIED");
    expect(e.message).toBe("没有访问权限");
    expect(e.details).toEqual({ description: "当前账号无法访问该资源。" });
    expect(e.requestId).toBe("r-1");
  });

  it("requestId 为 null 时保持 null", () => {
    const e = fromVisibleError({
      code: "X",
      title: "t",
      description: "d",
      retryable: true,
      requestId: null,
    });
    expect(e.requestId).toBeNull();
    expect(e.retryable).toBe(true);
  });
});

describe("四层互通（收敛目标）", () => {
  it("ControlPlaneRequestError 可被统一处理（instanceof AppError）", () => {
    const cpe = new ControlPlaneRequestError("INTERNAL_ERROR", "内部错误", "", true, 500);
    expect(isAppError(cpe)).toBe(true);
    expect(cpe.retryable).toBe(true);
    expect(toAppError(cpe)).toBe(cpe);
  });

  it("Desktop 错误体与 Visible 错误都能归一为同一类型", () => {
    const a = fromDesktopErrorLike({ code: "tab_not_found", message: "x" });
    const b = fromVisibleError({
      code: "ACCESS_DENIED",
      title: "t",
      description: "d",
      retryable: false,
      requestId: null,
    });
    expect(a).toBeInstanceOf(AppError);
    expect(b).toBeInstanceOf(AppError);
    expect(a.constructor).toBe(b.constructor);
  });
});
