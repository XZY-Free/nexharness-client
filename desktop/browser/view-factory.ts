/**
 * WebContentsView 创建与安全配置（从 browser-controller 抽出）。
 *
 * 抽出的价值：**WebContents 的安全参数是攻击面**（sandbox / contextIsolation /
 * nodeIntegration / webSecurity…）。原先内联在 createTab 里，只有一句注释；
 * 现在集中为常量 + 可断言函数，任何放宽都要过测试。
 *
 * 仅依赖注入的 factory（不 import electron），便于单测；
 * 真实创建由调用方传入 electron 的 WebContentsView 构造器。
 */

/** WebContentsView 的安全 webPreferences（**全部为最严默认，不得随意放宽**）。 */
export const SECURE_WEB_PREFERENCES = {
  /** 启用渲染进程沙箱。 */
  sandbox: true,
  /** 上下文隔离（preload 与页面 JS 分离）。 */
  contextIsolation: true,
  /** 禁止页面直接访问 Node（否则可任意读写文件）。 */
  nodeIntegration: false,
  /** 保持同源策略。 */
  webSecurity: true,
  /** 禁止在 HTTPS 页面加载 HTTP 子资源。 */
  allowRunningInsecureContent: false,
} as const;

/** 创建参数。 */
export interface ViewCreationParams {
  /** Session partition（如 persist:user-xxx / 匿名 incognito）。 */
  readonly partition: string;
}

/** WebContentsView 构造器的最小签名（真实 electron 或替身）。 */
export type WebContentsViewCtor = new (options: {
  webPreferences: { partition: string } & typeof SECURE_WEB_PREFERENCES;
}) => unknown;

/**
 * 创建配置好安全参数的 WebContentsView。
 *
 * 注意：`partition` 是唯一可变量；**安全参数恒为 SECURE_WEB_PREFERENCES**，
 * 不接受调用方覆盖（避免某处为了"方便"而放宽 nodeIntegration 之类）。
 */
export function createSecureView<T extends WebContentsViewCtor>(
  Ctor: T,
  params: ViewCreationParams,
): InstanceType<T> {
  return new Ctor({
    webPreferences: {
      partition: params.partition,
      ...SECURE_WEB_PREFERENCES,
    },
  }) as InstanceType<T>;
}

/**
 * 计算 tab 应使用的 Session partition。
 *
 * 规则（与原实现一致）：
 * - incognito → 每次创建新的匿名 partition（按 threadId 派生 + 随机 nonce，
 *   nonce 不传由 sessionManager 决定）
 * - 普通 → 按 userId 复用；userId 为空时**回退到 threadId**，
 *   保证不同 Thread 的 session 相互隔离（否则会共用一个 partition 而串 cookie）
 */
export function resolvePartitionKey(params: {
  readonly userId?: string;
  readonly threadId: string;
}): string {
  return params.userId && params.userId.length > 0 ? params.userId : params.threadId;
}
