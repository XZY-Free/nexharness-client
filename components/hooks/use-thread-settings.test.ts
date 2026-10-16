// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const apiFetchMock = vi.fn();
vi.mock("@/lib/api-fetch", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiPath: (p: string) => p,
}));

import { useThreadSettings } from "./use-thread-settings";

/**
 * useThreadSettings 封装 PATCH settings（乐观锁 If-Match + busy 互斥 + 空更新拒绝）。
 * 这些用例锁定：ETag 头形状、busy 期间禁重复、空 updates 不发请求、错误映射。
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 注：不用 beforeEach reset —— 每条例内自行 mockReset，避免 hook 超时误报。

describe("useThreadSettings", () => {
  it("fetch 抛错 → NETWORK_ERROR", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(() => {
      const rejected = Promise.reject(new Error("down"));
      // 预先挂 noop catch：避免 ls 在被 hook await 之前被判 unhandled rejection
      // （hook 内的 await 仍会正常 reject 并被 catch）。
      rejected.catch(() => {});
      return rejected;
    });
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    await act(async () => {
      await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m" },
      });
    });
    expect(result.current.error?.code).toBe("NETWORK_ERROR");
  });

  it("busy 期间重复调用直接返回 false（不重复发请求）", async () => {
    apiFetchMock.mockReset();
    // 永不 resolve 的 pending promise → 第一次调用停在 busy=true。
    // 关键：在 act 内 flush 一个 microtask（不 await 那个永不 settle 的 promise），
    // 否则 act 会一直等待，导致 hook 超时。
    let resolveFn: (r: Response) => void = () => {};
    apiFetchMock.mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolveFn = res;
        }),
    );
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));

    let first: Promise<boolean> | undefined;
    await act(async () => {
      first = result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m" },
      });
      await Promise.resolve(); // flush 掉 setBusy(true)
    });
    expect(result.current.busy).toBe(true);

    let secondOk: boolean | undefined;
    await act(async () => {
      secondOk = await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m" },
      });
    });
    expect(secondOk).toBe(false);
    expect(apiFetchMock).toHaveBeenCalledTimes(1); // 只有第一次真的发请求

    // 收尾：resolve 第一个，避免悬挂 promise 泄漏到后续用例
    await act(async () => {
      resolveFn(jsonResponse({}));
      await first;
    });
    expect(result.current.busy).toBe(false);
  });

  it("初始 busy=false / error=null", () => {
    apiFetchMock.mockReset();
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("空 updates 不发请求，返回 false 且设置参数错误", async () => {
    apiFetchMock.mockReset();
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.patchSettings({ expectedVersionNo: 1, updates: {} });
    });
    expect(ok).toBe(false);
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(result.current.error?.code).toBe("REQUEST_SCHEMA_INVALID");
    expect(result.current.error?.retryable).toBe(false);
  });

  it("PATCH 成功：返回 true，携带 If-Match 与 body", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(jsonResponse({}, 200));
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.patchSettings({
        expectedVersionNo: 7,
        updates: { default_model_ref: "m2" },
      });
    });
    expect(ok).toBe(true);
    expect(result.current.error).toBeNull();

    const [path, init] = apiFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/threads/t1/settings");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["if-match"]).toBe('"thread-settings-7"');
    expect(JSON.parse(init.body as string)).toEqual({ default_model_ref: "m2" });
  });

  it("update 含 null 值也算有效更新（显式清除）", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(jsonResponse({}));
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    await act(async () => {
      await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: null },
      });
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("服务端错误 envelope 映射为可见错误", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: "ETAG_MISMATCH", message: "x", request_id: "r", retryable: true } },
        412,
      ),
    );
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m" },
      });
    });
    expect(ok).toBe(false);
    expect(result.current.error?.code).toBe("ETAG_MISMATCH");
  });

  it("非 JSON 错误 body 降级为 NETWORK_ERROR", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    await act(async () => {
      await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m" },
      });
    });
    expect(result.current.error?.code).toBe("NETWORK_ERROR");
    expect(result.current.error?.retryable).toBe(true);
  });

  it("clearError 清除错误", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(jsonResponse({}, 500));
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    await act(async () => {
      await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m" },
      });
    });
    expect(result.current.error).not.toBeNull();
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("成功后 busy 复位为 false", async () => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue(jsonResponse({}));
    const { result } = renderHook(() => useThreadSettings({ threadId: "t1" }));
    await act(async () => {
      await result.current.patchSettings({
        expectedVersionNo: 1,
        updates: { default_model_ref: "m" },
      });
    });
    expect(result.current.busy).toBe(false);
  });
});
