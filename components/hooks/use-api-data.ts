/**
 * 轻量 JSON API 数据钩子（Studio 页面数据 API 化）。
 *
 * 语义：
 * - 挂载 / path 变更时发起一次 GET（cache: no-store；cookie 会话直通）。
 * - 成功响应为裸资源（apiSuccess），直接使用响应体。
 * - 失败保留 HTTP 状态与错误消息（供页面区分 401/403/404/500）。
 * - reload() 触发一次重取；组件卸载后丢弃在途结果。
 *
 * 与 control-plane-client 的关系（P2-6 收敛）：
 * 两者是**同一套取数语义**——都走 apiFetch（cookie 会话 + basePath），
 * 且错误统一归一为 `AppError`（lib/errors/app-error）。区别在定位：
 * - control-plane-client：领域对象 + 强类型 DTO + 抛错
 * - 本 hook：页面取数 + 状态机（data/loading/httpStatus/errorMessage）
 * 故不合并为一个（强行合并会让 8 个页面大改且引入行为差异），
 * 但**传输层与错误模型已统一**，跨层传错误不再需要手工适配。
 */
import { apiFetch } from "@/lib/api-fetch";
import { type AppError, toAppError } from "@/lib/errors/app-error";
import { useCallback, useEffect, useState } from "react";

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

export function useApiData<T>(path: string): ApiDataState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [httpStatus, setHttpStatus] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [version, setVersion] = useState(0);

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
        const response = await apiFetch(path, { cache: "no-store" });
        const body = (await response.json().catch(() => null)) as unknown;
        if (!active) return;
        if (!response.ok) {
          const envelope = extractErrorEnvelope(body);
          const appError = toAppError(
            envelope ?? {
              code: `HTTP_${response.status}`,
              message: `请求失败（HTTP ${response.status}）`,
              requestId: response.headers.get("x-request-id"),
              retryable: response.status >= 500,
            },
          );
          setHttpStatus(response.status);
          setErrorMessage(appError.message);
          setError(appError);
          setData(null);
          return;
        }
        setData(body as T);
      } catch (cause) {
        if (!active) return;
        // 传输层失败统一归一为 AppError（code=NETWORK_ERROR，retryable=true）
        const appError = toAppError(cause);
        setHttpStatus(0);
        setErrorMessage("网络请求失败，请检查连接后重试");
        setError(appError);
        setData(null);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [path, version]);

  return { data, loading, httpStatus, errorMessage, error, reload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 从服务端错误 Envelope 提取可归一的形状（{error:{code,message,...}}）。 */
function extractErrorEnvelope(
  body: unknown,
): { code: string; message: string; requestId: string | null; retryable: boolean } | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const { code, message, request_id, retryable } = body.error;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return {
    code,
    message,
    requestId: typeof request_id === "string" ? request_id : null,
    retryable: retryable === true,
  };
}
