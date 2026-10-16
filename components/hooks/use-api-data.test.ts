// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useApiData } from "./use-api-data";

/**
 * useApiData 是 Studio 页面取数的状态机（8 处消费）。
 *
 * 注意：本 hook 的传输层已委托给 control-plane 的 createControlPlaneRequest
 * （内部走 apiFetch → fetch），因此这里 mock 的层级是 **globalThis.fetch**，
 * 而不是原来的 apiFetch —— 这同时验证了"两条路已统一到同一传输层"。
 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("useApiData — 成功", () => {
  it("初始 loading，成功后填充 data 并清空错误", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ items: [1, 2] }));
    const { result } = renderHook(() => useApiData<{ items: number[] }>("/x"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ items: [1, 2] });
    expect(result.current.httpStatus).toBeNull();
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.error).toBeNull();
    spy.mockRestore();
  });

  it("请求带 cache: no-store", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    const { result } = renderHook(() => useApiData("/y"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.cache).toBe("no-store");
    spy.mockRestore();
  });
});

describe("useApiData — 失败（经 control-plane 统一错误模型）", () => {
  it("404 + 服务端 envelope → httpStatus=404 且 error.code 取自 envelope", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "不存在",
            request_id: "r1",
            retryable: false,
          },
        },
        404,
      ),
    );
    const { result } = renderHook(() => useApiData("/missing"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.httpStatus).toBe(404);
    expect(result.current.errorMessage).toBe("不存在");
    expect(result.current.error?.code).toBe("RESOURCE_NOT_FOUND");
    expect(result.current.error?.requestId).toBe("r1");
    expect(result.current.error?.retryable).toBe(false);
    expect(result.current.data).toBeNull();
    spy.mockRestore();
  });

  it("500 → retryable=true", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "内部错误",
            request_id: "r2",
            retryable: true,
          },
        },
        500,
      ),
    );
    const { result } = renderHook(() => useApiData("/boom"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.retryable).toBe(true);
    expect(result.current.httpStatus).toBe(500);
    spy.mockRestore();
  });

  it("非 2xx 且无合法 envelope → 兜底 INTERNAL_ERROR（control-plane 行为）", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<html>", { status: 502 }));
    const { result } = renderHook(() => useApiData("/bad"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.httpStatus).toBe(502);
    // control-plane 对无效错误响应统一抛 INTERNAL_ERROR 且 >=500 视为可重试
    expect(result.current.error?.code).toBe("INTERNAL_ERROR");
    expect(result.current.error?.retryable).toBe(true);
    spy.mockRestore();
  });

  it("网络异常 → httpStatus=0、错误文案、error 归一", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const rejected = Promise.reject(new Error("ECONNREFUSED"));
      rejected.catch(() => {});
      return rejected;
    });
    const { result } = renderHook(() => useApiData("/net"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.httpStatus).toBe(0);
    expect(result.current.errorMessage).toBe("网络请求失败，请检查连接后重试");
    expect(result.current.error).not.toBeNull();
    expect(result.current.data).toBeNull();
    spy.mockRestore();
  });
});

describe("useApiData — reload", () => {
  it("reload() 重新发起请求", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ n: 1 }));
    const { result } = renderHook(() => useApiData("/r"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      result.current.reload();
      expect(spy).toHaveBeenCalledTimes(2);
    });
    spy.mockRestore();
  });
});
