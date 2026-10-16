/**
 * Tab 生命周期规则（纯逻辑，不依赖 electron）。
 *
 * 从 desktop/browser/browser-controller.ts 抽出 —— 该文件曾是 1485 行上帝类，
 * 其中"关闭 tab 后该怎么办"的规则与 Electron 副作用（removeChildView / webContents.close）
 * 混在一起，无法单测。本模块只保留**可测的判定规则**，副作用仍留在 controller。
 */

/** 关闭 tab 的决策（供 controller 执行副作用）。 */
export interface CloseTabDecision {
  /**
   * 是否需要销毁该 thread 的 incognito session。
   *
   * 规则：被关闭的是 incognito tab，且该 thread 已**没有**其它 incognito tab。
   * （非 incognito tab 关闭不影响 session；还有其它 incognito tab 时保持 session。）
   */
  readonly destroyIncognitoSession: boolean;
}

/**
 * 判断关闭某 tab 后，是否需要销毁其 incognito session。
 *
 * @param closedTabIncognito 被关闭的 tab 是否为 incognito（tab 不存在时为 false）
 * @param remainingTabs 关闭后该 thread 剩余的 tab 列表（只用到 incognito 字段）
 */
export function decideCloseTab(
  closedTabIncognito: boolean,
  remainingTabs: readonly { readonly incognito: boolean }[],
): CloseTabDecision {
  if (!closedTabIncognito) return { destroyIncognitoSession: false };
  const stillHasIncognito = remainingTabs.some((t) => t.incognito);
  return { destroyIncognitoSession: !stillHasIncognito };
}

/** 下载上传结果的三态决策（成功 / 失败）。 */
export type UploadOutcome =
  | { readonly state: "uploaded"; readonly workspacePath: string }
  | { readonly state: "upload_failed"; readonly error: string };

/**
 * 根据上传结果决定 DownloadManager 的目标状态。
 *
 * 约束：**不伪装成功** —— 只有真正拿到 workspacePath 才算 uploaded；
 * 其余（ok=false 或缺 workspacePath）一律 upload_failed 并带错误信息。
 */
export function decideUploadOutcome(result: {
  readonly ok: boolean;
  readonly workspacePath: string | null;
  readonly error?: string;
}): UploadOutcome {
  if (result.ok && result.workspacePath) {
    return { state: "uploaded", workspacePath: result.workspacePath };
  }
  return { state: "upload_failed", error: result.error ?? "上传失败" };
}

/** 清理决策：哪些下载状态需要清理本机临时文件。 */
export type DownloadCleanupReason = "uploaded" | "upload_failed" | "cancelled" | "interrupted";

/**
 * 判断某个下载终态是否需要清理本机文件。
 *
 * 规则（fire-and-forget 语义）：
 * - uploaded：文件已进 workspace，本机副本无价值 → 清理
 * - upload_failed：不重试，保留只会成孤儿 → 清理
 * - cancelled / interrupted：Electron 可能已写入部分内容 → 清理
 *
 * 即：**所有终态都清理**。本函数把这些语义固化为可测断言，
 * 避免未来有人"为了保留现场"而留下孤儿文件。
 */
export function shouldCleanupLocalFile(reason: DownloadCleanupReason): boolean {
  switch (reason) {
    case "uploaded":
    case "upload_failed":
    case "cancelled":
    case "interrupted":
      return true;
    default:
      return true;
  }
}
