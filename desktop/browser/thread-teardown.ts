/**
 * Thread 关闭时的资源清理编排（从 browser-controller 抽出，原 closeThread 51 行）。
 *
 * 抽出价值：这段是**清理清单** —— 漏掉任意一项都会泄漏资源（view / debugger /
 * 监控 ref / 洞察缓冲 / incognito session / 下载记录 / 临时文件 / QA 上下文 /
 * tab 状态 / 持久化记录）。
 *
 * 原先 12 条清理语句平铺在方法里，没有"清单"这个显式概念，改代码时容易漏。
 * 现在：清单显式列出 + 每一项都有测试断言被调用（CLEANUP_STEPS），
 * 新增资源只需往清单加一项，测试会强制其被覆盖。
 *
 * 依赖注入（ThreadTeardownDeps）→ 可用替身验证"每一项都被调用"。
 */

/** 清理依赖（Thread 关闭时需要触及的全部子系统）。 */
export interface ThreadTeardownDeps {
  /** 该 Thread 的全部 viewId（清理 view 与监控 ref 用）。 */
  getViewIds: (threadId: string) => string[];
  /**
   * 移除并关闭指定 tab 的 view（含从 contentView 移除 + 关 webContents）。
   * 以 tabId 为参数而非 view 对象：controller 从自己的 registry 取真实
   * WebContentsView，避免抽象视图与 Electron 对象之间的转换。
   * 返回该 view 的 webContentsId（用于清反向索引）；view 不存在返回 null。
   */
  removeAndCloseView: (threadId: string, tabId: string) => number | null;
  /** 清 webContents 反向索引。 */
  forgetWebContents: (webContentsId: number) => void;
  /** 清该 tab 的 lastBounds。 */
  forgetBounds: (threadId: string, tabId: string) => void;
  /** 清空该 Thread 的 view 注册表。 */
  clearViews: (threadId: string) => void;
  /** 强制 detach 该 Thread 的 DebuggerSession。 */
  clearDebuggerSessions: (threadId: string) => void;
  /** 释放该 tab 的监控 ref。 */
  releaseMonitoring: (threadId: string, tabId: string) => void;
  /** 清页面洞察缓冲。 */
  clearPageInsights: (threadId: string) => void;
  /** 销毁 incognito partitions。 */
  destroyIncognitoPartitions: (threadId: string) => void;
  /** 清下载记录（可选子系统）。 */
  clearDownloads?: (threadId: string) => void;
  /** 清理本地临时文件（fire-and-forget，不阻塞）。 */
  cleanupTempFiles: (threadId: string) => void;
  /** 关闭 QA 上下文（可选子系统）。 */
  closeQa?: (threadId: string) => void;
  /** 关闭全部 tab 并返回数量。 */
  closeAllTabs: (threadId: string) => number;
  /** 删除持久化恢复记录（可选）。 */
  deleteRestoreRecord?: (threadId: string) => void;
}

/** 清单：清理步骤名（用于测试断言每一项都被执行）。 */
export const CLEANUP_STEPS = [
  "removeAndCloseView",
  "forgetWebContentsIndex",
  "forgetBounds",
  "clearViewRegistry",
  "clearDebuggerSessions",
  "releaseMonitoring",
  "clearPageInsights",
  "destroyIncognitoPartitions",
  "clearDownloads",
  "cleanupTempFiles",
  "closeQa",
  "closeAllTabs",
  "deleteRestoreRecord",
] as const;

export type CleanupStep = (typeof CLEANUP_STEPS)[number];

/**
 * 执行 Thread 关闭清理。
 *
 * 顺序（与原实现一致，含原因）：
 * 1. 先移除 view + 关 webContents（此时 viewId 列表已取到，可复用）
 * 2. 再清各类索引/缓冲（此时不应再有任何 view 引用）
 * 3. 最后关 tab 状态 + 删持久化记录（保证不再被恢复）
 *
 * @returns 关闭的 tab 数量
 */
export function teardownThread(threadId: string, deps: ThreadTeardownDeps): number {
  // ① 取 viewId 快照（后续循环复用，避免中途变化）
  const viewIds = deps.getViewIds(threadId);

  for (const tabId of viewIds) {
    const webContentsId = deps.removeAndCloseView(threadId, tabId);
    if (webContentsId !== null) deps.forgetWebContents(webContentsId);
    deps.forgetBounds(threadId, tabId);
  }

  // ② 清注册表与各类缓冲
  deps.clearViews(threadId);
  deps.clearDebuggerSessions(threadId);
  for (const tabId of viewIds) {
    deps.releaseMonitoring(threadId, tabId);
  }
  deps.clearPageInsights(threadId);
  deps.destroyIncognitoPartitions(threadId);
  deps.clearDownloads?.(threadId);
  // fire-and-forget：不 await，closeThread 需同步返回
  deps.cleanupTempFiles(threadId);
  deps.closeQa?.(threadId);

  // ③ 关 tab 状态 + 删持久化记录
  const count = deps.closeAllTabs(threadId);
  deps.deleteRestoreRecord?.(threadId);
  return count;
}
