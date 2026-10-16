/**
 * 统一应用错误基类与收口转换。
 *
 * 背景：客户端此前有四套错误表示，各有职责但**无共同祖先**，跨层传递需手工适配：
 * - `lib/error-codes.ts`        —— 错误码目录（code → {http, retryable}）
 * - `lib/desktop/errors.ts`     —— Desktop IPC/RPC 错误体（`{ok:false, code, message}`）
 * - `control-plane-client/...`  —— HTTP 传输错误（`ControlPlaneRequestError`）
 * - `lib/client/error-messages.ts` —— 员工可读映射（`ClientVisibleError`）
 *
 * 本模块**不推翻**上述四者（它们职责正确），而是补上缺失的一环：
 * 一个共同祖先 `AppError` + 把任意来源错误归一为它的 `toAppError()`。
 *
 * 设计约束：
 * - `AppError` 继承原生 `Error`，保留 `cause` 链（诊断不丢栈）。
 * - `code` 保持 `string`（各层码空间不同，不强求联合类型统一）。
 * - `retryable` / `requestId` 为可选附加信息，缺失时给安全默认（false / null）。
 * - 未知值兜底为 `UNKNOWN_ERROR`，**绝不抛出**（收口函数不能自己失败）。
 */

/** 未知错误的兜底码。 */
export const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";

/** 网络层失败的码（与各层既有语义一致）。 */
export const NETWORK_ERROR_CODE = "NETWORK_ERROR";

/** AppError 的构造参数。 */
export interface AppErrorInit {
  readonly code: string;
  readonly message: string;
  /** 是否可重试。默认 false（安全默认：不鼓励盲目重试）。 */
  readonly retryable?: boolean;
  /** 诊断用 request id（不直接展示给用户）。默认 null。 */
  readonly requestId?: string | null;
  /** 附加诊断上下文（不得含敏感数据）。 */
  readonly details?: Record<string, unknown>;
  /** 原始错误（保留栈与因果链）。 */
  readonly cause?: unknown;
}

/**
 * 统一应用错误。
 *
 * 各层错误类型都应能转换到此类型（见本文件底部的 from* 函数）。
 */
export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly details?: Record<string, unknown>;

  constructor(init: AppErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = "AppError";
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.requestId = init.requestId ?? null;
    this.details = init.details;
  }
}

/** 类型守卫：是否为 AppError（含子类）。 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** 形状守卫：是否有 code + message（用于识别"类错误"对象，不依赖原型链）。 */
function looksLikeError(value: unknown): value is { code: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  // 属性访问可能触发 getter 抛错（恶意/异常对象）—— 这里必须安全读取
  try {
    const code = (value as { code?: unknown }).code;
    const message = (value as { message?: unknown }).message;
    return typeof code === "string" && typeof message === "string";
  } catch {
    return false;
  }
}

/** 安全读取对象属性（getter 抛错时返回 undefined）。 */
function safeGet(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * 把任意来源的错误归一为 `AppError`。**此函数不抛出**。
 *
 * 识别顺序：
 * 1. 已是 `AppError` → 原样返回（幂等）
 * 2. 原生 `Error` → code=UNKNOWN_ERROR，message 取其 message，cause 保留
 * 3. 类错误对象（含 string code + message）→ 采用其 code/message/retryable/requestId
 * 4. 其它（字符串 / 数字 / null / undefined）→ UNKNOWN_ERROR + 字符串化
 *
 * @param value 任意来源错误
 * @returns 归一后的 AppError（永不 null）
 */
export function toAppError(value: unknown): AppError {
  if (value instanceof AppError) return value;

  if (value instanceof Error) {
    // 类错误对象（如 ControlPlaneRequestError）在 instanceof Error 分支前被下面的形状检查捕获；
    // 走到这里说明是纯 Error —— 但也可能有挂载的 code（如 Node 的 err.code）。
    const maybeCode = safeGet(value, "code");
    const code =
      typeof maybeCode === "string" && maybeCode.length > 0 ? maybeCode : UNKNOWN_ERROR_CODE;
    const maybeRetryable = safeGet(value, "retryable");
    const maybeRequestId = safeGet(value, "requestId");
    return new AppError({
      code,
      message: value.message || String(value),
      retryable: maybeRetryable === true,
      requestId: typeof maybeRequestId === "string" ? maybeRequestId : null,
      cause: value,
    });
  }

  if (looksLikeError(value)) {
    const retryable = safeGet(value, "retryable");
    const requestId = safeGet(value, "requestId");
    const details = safeGet(value, "details");
    const code = safeGet(value, "code");
    const message = safeGet(value, "message");
    return new AppError({
      code: typeof code === "string" ? code : UNKNOWN_ERROR_CODE,
      message: typeof message === "string" ? message : "发生未知错误",
      retryable: retryable === true,
      requestId: typeof requestId === "string" ? requestId : null,
      details:
        typeof details === "object" && details !== null
          ? (details as Record<string, unknown>)
          : undefined,
      cause: value,
    });
  }

  // 兜底：字符串 / 数字 / null / undefined / 其它
  return new AppError({
    code: UNKNOWN_ERROR_CODE,
    message: typeof value === "string" ? value : "发生未知错误",
    cause: value,
  });
}

/**
 * 归一"网络请求失败"（fetch reject / 连接拒绝）。
 *
 * 与 `toAppError` 区分：这里的失败**确定是传输层**，码固定为 NETWORK_ERROR 且可重试。
 */
export function fromNetworkFailure(cause: unknown): AppError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new AppError({
    code: NETWORK_ERROR_CODE,
    message: `网络请求失败：${detail}`,
    retryable: true,
    cause,
  });
}

/**
 * 归一 Desktop IPC/RPC 错误体（`{ok:false, code, message}` 形状）。
 *
 * 注意：Desktop 错误码是**小写下划线**命名（如 `tab_not_found`），与 API 的
 * 大写下划线（`TAB_NOT_FOUND`）不同 —— 本函数保持原码，由展示层决定映射。
 */
export function fromDesktopErrorLike(value: {
  code: string;
  message: string;
  detail?: unknown;
}): AppError {
  return new AppError({
    code: value.code,
    message: value.message,
    details:
      typeof value.detail === "object" && value.detail !== null
        ? (value.detail as Record<string, unknown>)
        : undefined,
    cause: value,
  });
}

/**
 * 归一员工可见错误（`ClientVisibleError`，已是可读形态）。
 *
 * 该形态只有中文 title/description，没有原始 message；这里用 title 作为 message
 * （信息量最高且不泄露内部细节），description 放入 details 供诊断。
 */
export function fromVisibleError(value: {
  code: string;
  title: string;
  description: string;
  retryable: boolean;
  requestId: string | null;
}): AppError {
  return new AppError({
    code: value.code,
    message: value.title,
    retryable: value.retryable,
    requestId: value.requestId,
    details: { description: value.description },
    cause: value,
  });
}
