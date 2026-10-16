/**
 * 下载协调器：把 Electron `will-download` 生命周期接到 DownloadManager + workspace 上传。
 *
 * 从 desktop/browser/browser-controller.ts 抽出（原 setupDownloadHandler +
 * uploadDownload + cleanupCancelledDownload，约 108 行）。
 *
 * 设计：**依赖注入**，不直接持有 BrowserWindow / Session —— 因此可用 fake 依赖单测
 * （Electron 的 DownloadItem / Session 无法在 vitest 里实例化）。
 *
 * 不变性（与原实现保持一致）：
 * - 未知 webContents（无 threadId 归属）→ 忽略，不创建记录
 * - 下载完成 → 注册临时文件 + fire-and-forget 上传（不阻塞、不抛出）
 * - cancelled / interrupted → 主动清理可能已写入的部分文件（防孤儿）
 * - 上传成功 / 失败都清理本机文件（fire-and-forget 不重试，保留只会成孤儿）
 * - 上传结果不伪装成功：只有拿到 workspacePath 才 uploaded
 */
import { decideUploadOutcome, shouldCleanupLocalFile } from "./tab-lifecycle";

/** 上传结果（与 download-uploader 的返回形状一致）。 */
export interface UploadOutcomeResult {
  readonly ok: boolean;
  readonly workspacePath: string | null;
  readonly error?: string;
}

/** Electron DownloadItem 的最小接口（便于测试替身）。 */
export interface DownloadItemLike {
  getFilename(): string;
  getURLChain(): string[] | undefined;
  getMimeType(): string;
  getTotalBytes(): number;
  getReceivedBytes(): number;
  getSavePath(): string;
  on(event: "updated", listener: (event: unknown, state: string) => void): void;
  on(event: "done", listener: (event: unknown, state: string) => void): void;
}

/** DownloadManager 的最小接口。 */
export interface DownloadManagerLike {
  createDownload(input: {
    threadId: string;
    tabId: string;
    fileName: string;
    url: string;
    mimeType: string;
    totalBytes: number;
  }): { id: string };
  updateProgress(id: string, receivedBytes: number): void;
  completeDownload(id: string, savedPath: string): void;
  cancelDownload(id: string): void;
  failDownload(id: string, reason: string): void;
  startUpload(id: string): void;
  completeUpload(id: string, workspacePath: string): void;
  failUpload(id: string, error: string): void;
}

/** 协调器依赖（全部注入，便于测试）。 */
export interface DownloadCoordinatorDeps {
  readonly downloadManager: DownloadManagerLike;
  /** 上传配置；为 null 时下载完成不上传（仅记记录）。 */
  readonly getUploadConfig: () => { serverOrigin: string; authToken?: string } | null;
  /** 反查 webContents 归属；未知返回 null。 */
  readonly resolveTab: (webContentsId: number) => { threadId: string; tabId: string } | null;
  /** 注册临时文件（供后续清理）。 */
  readonly registerTempFile: (threadId: string, path: string, kind: "download") => void;
  /** 上传实现（默认走 download-uploader；测试可替换）。 */
  readonly uploadFile: (params: {
    config: { serverOrigin: string; authToken?: string };
    threadId: string;
    filePath: string;
    fileName: string;
  }) => Promise<UploadOutcomeResult>;
  /** 清理本机文件（幂等；文件不存在也应成功）。 */
  readonly cleanupFile: (path: string) => Promise<boolean>;
}

/**
 * 处理一次 `will-download` 事件（绑定记录、进度、终态）。
 *
 * @returns 创建的下载记录 id；被忽略时返回 null（未知 webContents）
 */
export function handleWillDownload(
  deps: DownloadCoordinatorDeps,
  item: DownloadItemLike,
  webContentsId: number,
): string | null {
  const idx = deps.resolveTab(webContentsId);
  if (!idx) return null; // 未知 webContents，忽略

  const { threadId, tabId } = idx;
  const fileName = item.getFilename();
  const urlChain = item.getURLChain();
  const url = (urlChain && urlChain.length > 0 ? urlChain[0] : "") ?? "";

  const record = deps.downloadManager.createDownload({
    threadId,
    tabId,
    fileName,
    url,
    mimeType: item.getMimeType(),
    totalBytes: item.getTotalBytes(),
  });

  item.on("updated", (_e, state) => {
    if (state === "progressing") {
      deps.downloadManager.updateProgress(record.id, item.getReceivedBytes());
    }
  });

  item.on("done", (_e, state) => {
    if (state === "completed") {
      const savedPath = item.getSavePath();
      deps.downloadManager.completeDownload(record.id, savedPath);
      deps.registerTempFile(threadId, savedPath, "download");
      // fire-and-forget：不阻塞事件循环，失败仅记录（overall 状态由 manager 承载）
      if (deps.getUploadConfig()) {
        void uploadDownload(deps, record.id, threadId, savedPath, fileName);
      }
    } else if (state === "cancelled") {
      deps.downloadManager.cancelDownload(record.id);
      void cleanupCancelled(deps, item.getSavePath());
    } else {
      deps.downloadManager.failDownload(record.id, `下载${state}`);
      void cleanupCancelled(deps, item.getSavePath());
    }
  });

  return record.id;
}

/**
 * 流式上传本机下载文件到 Server workspace，并按结果更新 DownloadManager 状态。
 *
 * 成功 / 失败都清理本机文件：成功则副本无价值；失败则 fire-and-forget 不重试，
 * 保留只会堆积成孤儿。
 */
export async function uploadDownload(
  deps: DownloadCoordinatorDeps,
  downloadId: string,
  threadId: string,
  filePath: string,
  fileName: string,
): Promise<void> {
  const config = deps.getUploadConfig();
  if (!config) return;
  deps.downloadManager.startUpload(downloadId);

  const result = await deps.uploadFile({ config, threadId, filePath, fileName });

  const outcome = decideUploadOutcome(result);
  if (outcome.state === "uploaded") {
    deps.downloadManager.completeUpload(downloadId, outcome.workspacePath);
  } else {
    deps.downloadManager.failUpload(downloadId, outcome.error);
  }

  // 终态一律清理（语义见 tab-lifecycle#shouldCleanupLocalFile）
  if (shouldCleanupLocalFile(outcome.state)) {
    await deps.cleanupFile(filePath);
  }
}

/** 清理 cancelled / interrupted 下载残留的部分写入文件（防孤儿）。 */
export async function cleanupCancelled(
  deps: DownloadCoordinatorDeps,
  savePath: string,
): Promise<boolean> {
  return deps.cleanupFile(savePath);
}
