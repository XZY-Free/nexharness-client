/**
 * 导航操作命令。
 *
 * 定义用户和 AI 可发送的浏览器导航命令。
 * 纯函数校验命令参数，不依赖 electron。
 */

/** 导航命令类型 */
export type NavActionType = "navigate" | "back" | "forward" | "reload" | "stop";

/** 导航命令基础结构 */
export interface NavAction {
  type: NavActionType;
  threadId: string;
  tabId: string;
}

/** navigate 命令带 URL */
export interface NavigateAction extends NavAction {
  type: "navigate";
  url: string;
}

/** 其他命令不需要额外参数 */
export type BackAction = NavAction & { type: "back" };
export type ForwardAction = NavAction & { type: "forward" };
export type ReloadAction = NavAction & { type: "reload" };
export type StopAction = NavAction & { type: "stop" };

/** 所有导航命令 */
export type BrowserNavAction =
  | NavigateAction
  | BackAction
  | ForwardAction
  | ReloadAction
  | StopAction;

/** 命令校验结果 */
export interface NavActionResult {
  ok: boolean;
  action?: BrowserNavAction;
  error?: string;
}

/** URL 最大长度（防止超长 URL 攻击） */
export const MAX_URL_LENGTH = 8192;

/**
 * 校验 URL 是否为有效的 http/https URL。
 *
 * WebContentsView 只允许 http/https 导航。
 * file/data/blob/javascript 等协议被阻止。
 */
export function isValidNavUrl(url: unknown): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 校验并规范化 navigate 命令。
 *
 * @param raw - 原始输入
 * @returns 校验通过返回 action，否则返回 error
 */
export function validateNavAction(raw: unknown): NavActionResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "命令必须是对象" };
  }

  const obj = raw as Record<string, unknown>;
  const { type, threadId, tabId } = obj;

  // 校验 type
  if (typeof type !== "string") {
    return { ok: false, error: "type 必须是字符串" };
  }
  const validTypes = ["navigate", "back", "forward", "reload", "stop"];
  if (!validTypes.includes(type)) {
    return { ok: false, error: `type 必须是 ${validTypes.join("/")} 之一` };
  }

  // 校验 threadId
  if (typeof threadId !== "string" || threadId.length === 0) {
    return { ok: false, error: "threadId 必须是非空字符串" };
  }

  // 校验 tabId
  if (typeof tabId !== "string" || tabId.length === 0) {
    return { ok: false, error: "tabId 必须是非空字符串" };
  }

  // navigate 命令需要额外校验 URL
  if (type === "navigate") {
    if (!isValidNavUrl(obj.url)) {
      return { ok: false, error: "navigate 命令需要有效的 http/https URL" };
    }
    return {
      ok: true,
      action: { type: "navigate", threadId, tabId, url: obj.url as string },
    };
  }

  // 其他命令
  return {
    ok: true,
    action: { type: type as "back" | "forward" | "reload" | "stop", threadId, tabId },
  };
}

/**
 * 标准化 URL（补全 protocol、去除空白）。
 *
 * 用户在地址栏输入 "example.com" → "https://example.com"
 * 输入 "http://example.com" → 保持不变
 *
 * @param input - 用户输入
 * @returns 标准化后的 URL，或 null（无法标准化）
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // 已有协议
  if (/^https?:\/\//i.test(trimmed)) {
    return isValidNavUrl(trimmed) ? trimmed : null;
  }

  // 含明确协议标识（"scheme://"）但不是 http/https 的输入一律拒绝，
  // 不可当作域名补全（否则 "file:///x" 会被拼成 "https://file:///x"）。
  // 注意："example.com:8080" 是 host:port（scheme 后无 //），不应误判。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null;
  }
  // 已知危险协议（无 // 前缀形式，如 javascript:alert(1)、data:text/html,x）
  if (/^(?:javascript|data|blob|file|vbscript):/i.test(trimmed)) {
    return null;
  }

  // 无协议，补全 https://
  const withProtocol = `https://${trimmed}`;
  return isValidNavUrl(withProtocol) ? withProtocol : null;
}

// ─── 导航动作分发 ─────────────────────────────────────────────

/**
 * 导航目标的最小接口（Electron WebContents 的导航能力子集）。
 */
export interface NavTargetLike {
  loadURL(url: string): Promise<void> | void;
  reload(): void;
  stop(): void;
  navigationHistory: {
    canGoBack(): boolean;
    canGoForward(): boolean;
    goBack(): void;
    goForward(): void;
  };
}

/** 分发结果：是否执行了导航 + 是否需把 tab 标记为 loading。 */
export interface NavDispatchResult {
  /** 动作是否被实际执行（back/forward 在不可用时为 false）。 */
  readonly acted: boolean;
  /** 是否应把 tab 状态置为 loading（仅 navigate 动作）。 */
  readonly markLoading: boolean;
  /** navigate 动作的目标 URL（供状态更新用）。 */
  readonly url?: string;
}

/**
 * 把已验证的导航动作分发到 target 上。
 *
 * 抽出的价值：原 `BrowserController.navigate` 是一段 switch 分发，与 Electron 耦合
 * 但**逻辑本身可测** —— 本函数只依赖 NavTargetLike 接口，可用替身验证
 * "back 在 canGoBack=false 时不执行"这类规则。
 *
 * @param target 导航目标（真 WebContents 或替身）
 * @param action 已通过 validateNavAction 的动作
 */
export function dispatchNavAction(
  target: NavTargetLike,
  action: { type: string; url?: string },
): NavDispatchResult {
  switch (action.type) {
    case "navigate": {
      const url = action.url ?? "";
      void target.loadURL(url);
      return { acted: true, markLoading: true, url };
    }
    case "back": {
      if (!target.navigationHistory.canGoBack()) return { acted: false, markLoading: false };
      target.navigationHistory.goBack();
      return { acted: true, markLoading: false };
    }
    case "forward": {
      if (!target.navigationHistory.canGoForward()) return { acted: false, markLoading: false };
      target.navigationHistory.goForward();
      return { acted: true, markLoading: false };
    }
    case "reload": {
      target.reload();
      return { acted: true, markLoading: false };
    }
    case "stop": {
      target.stop();
      return { acted: true, markLoading: false };
    }
    default:
      return { acted: false, markLoading: false };
  }
}

// ─── 创建时的 URL 守卫（从 createTab 抽出）──────────────────────────

/** URL 守卫结果。 */
export type UrlGuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * createTab 的 URL 守卫：空 URL 允许（新空白标签页），非空须过 checkUrlSafety。
 *
 * 与 `will-navigate` 的拦截口径一致（同一 `checkUrlSafety`），
 * 但这里是**创建入口**：被阻止时抛出而非静默忽略（调用方能立刻感知）。
 *
 * @param url 待打开的 URL
 * @param isBlocked 注入的 URL 安全检查（默认 checkUrlSafety）
 */
export function guardCreateUrl(url: string, isBlocked: (url: string) => boolean): UrlGuardResult {
  if (url.length === 0) return { ok: true };
  if (isBlocked(url)) return { ok: false, reason: `URL 被阻止: ${url}` };
  return { ok: true };
}
