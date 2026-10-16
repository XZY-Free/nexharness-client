import { apiPath } from "@/lib/api-fetch";
import type { ApiErrorCode } from "@/lib/error-codes";
import { AppError } from "@/lib/errors/app-error";

export interface ApiClientConfig {
  baseUrl: string;
  headers: () => Record<string, string>;
  fetcher?: typeof fetch;
}

/**
 * 控制面请求错误。
 *
 * 继承 `AppError`（统一基类），因此可被 `toAppError()` 幂等识别，
 * 也可直接 `instanceof AppError` 收到统一处理。
 */
export class ControlPlaneRequestError extends AppError {
  readonly status: number;

  constructor(
    readonly code: ApiErrorCode | "INTERNAL_ERROR",
    message: string,
    requestId: string,
    retryable: boolean,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super({ code, message, requestId, retryable, details });
    this.name = "ControlPlaneRequestError";
    this.status = status;
  }
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.request_id === "string" &&
    typeof candidate.retryable === "boolean" &&
    (candidate.details === undefined ||
      (candidate.details !== null && typeof candidate.details === "object"))
  );
}

function joinUrl(baseUrl: string, path: string): string {
  if (!baseUrl) return apiPath(path);
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function createControlPlaneRequest(config: ApiClientConfig) {
  return async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(config.headers());
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (init?.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await (config.fetcher ?? fetch)(joinUrl(config.baseUrl, path), {
      ...init,
      headers,
    });
    const body = await parseJson(response);
    if (response.ok) return body as T;

    if (isErrorEnvelope(body)) {
      throw new ControlPlaneRequestError(
        body.error.code as ApiErrorCode,
        body.error.message,
        body.error.request_id,
        body.error.retryable,
        response.status,
        body.error.details,
      );
    }

    throw new ControlPlaneRequestError(
      "INTERNAL_ERROR",
      `控制面返回了无效错误响应（HTTP ${response.status}）`,
      response.headers.get("x-request-id") ?? "",
      response.status >= 500,
      response.status,
    );
  };
}
