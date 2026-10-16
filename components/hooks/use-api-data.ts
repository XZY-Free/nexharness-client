/**
 * 轻量 JSON API 数据钩子（Studio 页面数据 API 化）。
 *
 * 语义：
 * - 挂载 / path 变更时发起一次 GET（cache: no-store；cookie 会话直通）。
 * - 成功响应为裸资源（apiSuccess），直接使用响应体。
 * - 失败保留 HTTP 状态与错误消息（供页面区分 401/403/404/500）。
 * - reload() 触发一次重取；组件卸载后丢弃在途结果。
 *
 * 与 control-plane-client 的关系（P2-6 统一数据层）：
 * 本 hook 的**传输层已委托**给 control-plane 的 `createControlPlaneRequest`
 * —— 即 Studio 页面与领域面板走同一套请求实现、同一错误解析、同一错误模型
 * （`ControlPlaneRequestError extends AppError`）。
 * 本 hook 只额外承担"页面状态机"（data / loading / httpStatus / errorMessage）。
 *
 * 为什么不合并成一个 API：control-plane client 面向"领域对象 + 抛错"，
 * 本 hook 面向"页面取数 + 状态机"——两者是**分层**而非重复。
 * 统一在传输层，而非强行让 8 个页面改成直接调 client。
 */
import {
  type ApiClientConfig,
  ControlPlaneRequestError,
  createControlPlaneRequest,
} from "@/lib/control-plane-client";
import { type AppError, toAppError } from "@/lib/errors/app-error";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface ApiDataState<T> {
  readonly data: T | null;
  readonly loading: boolean;
  /** 非 2xx 时的 HTTP 状态；网络失败为 0；成功为 null。 */
  readonly httpStatus: number | null;
  readonly errorMessage: string | null;
  /** 归一后的错误对象（含 code / retryable / requestId）；无错误为 null。 */
  readonly error: AppError | null;
  readonly reload: () => void;
}

/** 请求配置：同源（baseUrl 为空）+ 无自定义 header（cookie 会话直通）。 */
const REQUEST_CONFIG: ApiClientConfig = {
  baseUrl: "",
  headers: () => ({}),
};

export function useApiData<T>(path: string): ApiDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [version, setVersion] = useState(0);

  // 传输层：与 Studio 领域面板共用 control-plane 的 request 实现
  // （同一错误解析 + 同一错误模型；网络失败会抛 ControlPlaneRequestError）
  const request = useMemo(() => createControlPlaneRequest(REQUEST_CONFIG), []);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 是手动重取信号（reload() 递增触发），非直接引用
  useEffect(() => {
    let active = true;
    setLoading(true);
    setHttpStatus(null);
    setErrorMessage(null);
    setError(null);
    void (async () => {
      try {
        const body = await request<T>(path, { cache: "no-store" });
        if (!active) return;
        setData(body);
      } catch (cause) {
        if (!active) return;
        // request 对非 2xx 抛 ControlPlaneRequestError（继承 AppError）；
        // 传输层失败（fetch reject）也会被包装 —— 二者在此统一归一。
        const appError = toAppError(cause);
        const status = cause instanceof ControlPlaneRequestError ? cause.status : 0;
        setHttpStatus(status === 0 ? 0 : status);
        setErrorMessage(status === 0 ? "网络请求失败，请检查连接后重试" : appError.message);
        setError(appError);
        setData(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [path, version, request]);

  return { data, loading, httpStatus, errorMessage, error, reload };
}
