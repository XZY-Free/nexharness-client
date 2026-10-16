// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPath: (p: string) => p,
}));

import { useApiData } from "./use-api-data";

/**
 * useApiData 是 Studio 页面取数的状态机（8 处消费）。
 * 这些用例锁定：成功/失败态形状、HTTP 状态透出、错误归一为 AppError、reload。
 */
function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("useApiData — 成功", () => {
  it("初始 loading，成功后填充 data 并清空错误", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(jsonResponse({ items: [1, 2] }));
    const { result } = renderHook(() => useApiData<{ items: number[] }>("/x"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ items: [1, 2] });
    expect(result.current.httpStatus).toBeNull();
    expect(result.current.errorMessage).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("请求带 cache: no-store 与 cookie 会话（走 apiFetch）", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(jsonResponse({}));
    const { result } = renderHook(() => useApiData("/y"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const [path, init] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/y");
    expect(init.cache).toBe("no-store");
  });
});

describe("useApiData — 失败（错误归一为 AppError）", () => {
  it("404 + 服务端 envelope → httpStatus=404 且 error.code 取自 envelope", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(
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
  });

  it("500 → retryable=true", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: { code: "INTERNAL_ERROR", message: "内部错误", request_id: "r2", retryable: true },
        },
        500,
      ),
    );
    const { result } = renderHook(() => useApiData("/boom"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.retryable).toBe(true);
  });

  it("非 2xx 且无合法 envelope → 兜底 HTTP_<status> 码", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(new Response("<html>", { status: 502 }));
    const { result } = renderHook(() => useApiData("/bad"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.httpStatus).toBe(502);
    expect(result.current.error?.code).toBe("HTTP_502");
    expect(result.current.error?.retryable).toBe(true); // >=500
  });

  it("网络异常 → httpStatus=0、错误文案、error 归一", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => {
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
  });
});

describe("useApiData — reload", () => {
  it("reload() 重新发起请求", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(jsonResponse({ n: 1 }));
    const { result } = renderHook(() => useApiData("/r"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      result.current.reload();
      expect(apiFetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
