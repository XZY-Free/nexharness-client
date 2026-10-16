// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPath: (p: string) => p,
}));

import { useAvailableModels } from "./use-available-models";

/**
 * useAvailableModels 加载模型列表（供模型选择器）。
 * 这些用例锁定：成功解析、过滤非法项、失败降级、卸载中止。
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("useAvailableModels", () => {
  it("初始为 loading", () => {
    // 挂起不 resolve：断言初始态
    apiFetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    const { result } = renderHook(() => useAvailableModels());
    expect(result.current.loading).toBe(true);
    expect(result.current.models).toEqual([]);
  });

  it("成功加载后填充 models / defaultModel 并结束 loading", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ models: [{ id: "m1" }, { id: "m2" }], defaultModel: "m1" }),
    );
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(result.current.defaultModel).toBe("m1");
    expect(result.current.error).toBeNull();
  });

  it("过滤掉 id 非字符串的非法项（防畸形数据进下拉）", async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse({ models: [{ id: "ok" }, { id: 123 }, { noId: true }, null] }),
    );
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models.map((m) => m.id)).toEqual(["ok"]);
  });

  it("models 缺失时为空数组；defaultModel 非字符串时为 null", async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ defaultModel: 42 }));
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models).toEqual([]);
    expect(result.current.defaultModel).toBeNull();
  });

  it("HTTP 非 2xx → 错误态（models 空）", async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({}, 500));
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("模型列表加载失败");
    expect(result.current.models).toEqual([]);
  });

  it("网络异常 → 错误态", async () => {
    // 用 mockImplementation 抛错（hook 内部 catch），避免 mockRejectedValue 的 unhandled rejection
    apiFetchMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    const { result } = renderHook(() => useAvailableModels());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("模型列表加载失败");
  });

  it("请求携带 AbortSignal（卸载时可中止）", async () => {
    apiFetchMock.mockResolvedValue(jsonResponse({ models: [] }));
    const { unmount } = renderHook(() => useAvailableModels());
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    const init = apiFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(() => unmount()).not.toThrow();
  });

  it("卸载后到达的响应不更新状态（防 setState on unmounted）", async () => {
    let resolveFn: (r: Response) => void = () => {};
    apiFetchMock.mockReturnValue(
      new Promise<Response>((res) => {
        resolveFn = res;
      }),
    );
    const { result, unmount } = renderHook(() => useAvailableModels());
    unmount();
    await act(async () => {
      resolveFn(jsonResponse({ models: [{ id: "x" }] }));
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(true); // 未被后到的响应改写
  });
});
