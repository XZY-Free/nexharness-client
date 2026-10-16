/**
 * 工作区文件上传（下载到临时文件 → CDP 设 file input → 清理）—— 从 controller 抽出。
 *
 * 安全约束（勿改，来自原实现）：
 * - `downloadUrl` 由 Server 签发（含一次性 token），AI 不能伪造
 * - **不接受本机任意路径作为输入**（避免 AI 越权读本地文件）
 * - 临时文件名用 UUID，避免与已有文件冲突
 *
 * 清理契约：**无论成功/失败都删临时文件**（含下载失败、acquire 失败、
 * CDP 失败各分支），否则临时目录会堆积。
 */

/** CDP 目标最小接口。 */
export interface UploadTargetLike {
  sendCommand(method: string, params: unknown): Promise<{ ok: boolean; result?: unknown }>;
}

/** 上传依赖（注入，便于测试）。 */
export interface FileUploadDeps {
  /** 生成临时文件路径（UUID）。 */
  makeTempPath: () => string;
  /** 下载 url 到本地文件；失败返回 false。 */
  downloadToFile: (url: string, dest: string) => Promise<boolean>;
  /** acquire debugger；失败返回 null。 */
  acquire: () => Promise<UploadTargetLike | null>;
  /** release debugger。 */
  release: () => void;
  /** 删除文件（幂等，失败不抛）。 */
  unlink: (filePath: string) => Promise<void>;
  /** 解析 document rootId（见 cdp-input）。 */
  extractRootId: (result: { ok: boolean; result?: unknown }) => number | null;
  /** 解析 querySelector nodeId（见 cdp-input）。 */
  extractNodeId: (result: { ok: boolean; result?: unknown }) => number | null;
}

/**
 * 执行上传：下载 → 定位 file input → 设文件 → 清理临时文件。
 *
 * @returns 是否成功把文件设给 file input
 */
export async function uploadWorkspaceFileWith(
  selector: string,
  downloadUrl: string,
  deps: FileUploadDeps,
): Promise<boolean> {
  const tempPath = deps.makeTempPath();

  // ① 下载（失败即清理并返回 false）
  const downloaded = await deps.downloadToFile(downloadUrl, tempPath);
  if (!downloaded) {
    await deps.unlink(tempPath);
    return false;
  }

  // ② acquire（失败即清理并返回 false）
  const target = await deps.acquire();
  if (!target) {
    await deps.unlink(tempPath);
    return false;
  }

  // ③ CDP 定位 + 设值（无论结果如何都要 release + 清理）
  try {
    const rootId = deps.extractRootId(await target.sendCommand("DOM.getDocument", { depth: 0 }));
    if (rootId === null) return false;

    const nodeId = deps.extractNodeId(
      await target.sendCommand("DOM.querySelector", { nodeId: rootId, selector }),
    );
    if (nodeId === null) return false;

    const setResult = await target.sendCommand("DOM.setFileInputFiles", {
      nodeId,
      files: [tempPath],
    });
    return setResult.ok;
  } finally {
    deps.release();
    await deps.unlink(tempPath);
  }
}

/**
 * 下载 URL 到本地文件（流式写入）。
 *
 * 用 `Readable.fromWeb` 把 fetch 的 Web ReadableStream 转 Node 流后 pipeline，
 * 避免整文件驻留内存。任一步失败返回 false（调用方负责清理部分写入的文件）。
 */
export async function downloadUrlToFileImpl(params: {
  url: string;
  dest: string;
  fetcher?: typeof fetch;
  createWriteStream: (dest: string) => NodeJS.WritableStream;
  fromWeb: (stream: unknown) => NodeJS.ReadableStream;
  pipeline: (src: NodeJS.ReadableStream, dest: NodeJS.WritableStream) => Promise<void>;
}): Promise<boolean> {
  try {
    const response = await (params.fetcher ?? fetch)(params.url);
    if (!response.ok || !response.body) return false;
    const nodeStream = params.fromWeb(response.body);
    await params.pipeline(nodeStream, params.createWriteStream(params.dest));
    return true;
  } catch {
    return false;
  }
}
