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
 * 单次下载的字节上限（默认 200 MiB）。
 *
 * `downloadUrl` 由 Server 签发，但下载目标（远端主机、响应体大小）不受本端控制。
 * 无上限时一个超大响应即可把磁盘写入到不可预期的规模；这里在流式写入过程中累计
 * 字节数并硬性中断。
 */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

/**
 * 下载 URL 的 host 白名单校验（可选注入）。
 *
 * 传入 allowedOrigins 时，`downloadUrl` 的 origin 必须在列表内；未传则不做 host 约束
 * （保持现有调用方行为不变，避免单侧收紧把已工作的链路打断）。
 */
export function isDownloadUrlAllowed(url: string, allowedOrigins?: readonly string[]): boolean {
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  return allowedOrigins.some((entry) => {
    try {
      return new URL(entry).origin === target.origin;
    } catch {
      return false;
    }
  });
}

/**
 * 下载 URL 到本地文件（流式写入）。
 *
 * 用 `Readable.fromWeb` 把 fetch 的 Web ReadableStream 转 Node 流后 pipeline，
 * 避免整文件驻留内存。任一步失败返回 false（调用方负责清理部分写入的文件）。
 *
 * 加固：
 * - 先校验响应 `content-length` 与累计字节数均不超过 maxBytes；
 * - 超限即销毁读取流并返回 false（调用方 unlink 已写入的部分文件）。
 */
export async function downloadUrlToFileImpl(params: {
  url: string;
  dest: string;
  fetcher?: typeof fetch;
  createWriteStream: (dest: string) => NodeJS.WritableStream;
  fromWeb: (stream: unknown) => NodeJS.ReadableStream;
  pipeline: (src: NodeJS.ReadableStream, dest: NodeJS.WritableStream) => Promise<void>;
  /** 允许的下载来源 origin 白名单；不传则不约束 host。 */
  allowedOrigins?: readonly string[];
  /** 字节上限，默认 MAX_DOWNLOAD_BYTES。 */
  maxBytes?: number;
}): Promise<boolean> {
  const maxBytes = params.maxBytes ?? MAX_DOWNLOAD_BYTES;
  if (!isDownloadUrlAllowed(params.url, params.allowedOrigins)) return false;
  try {
    const response = await (params.fetcher ?? fetch)(params.url);
    if (!response.ok || !response.body) return false;
    // 声明长度即超限（或非法）→ 不落盘
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return false;

    const nodeStream = params.fromWeb(response.body);
    let received = 0;
    let exceeded = false;
    nodeStream.on("data", (chunk: Buffer | string) => {
      received += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (received > maxBytes && !exceeded) {
        exceeded = true;
        // 中断读取；pipeline 随之以错误结束（被 catch 吞掉并返回 false）
        (nodeStream as { destroy?: (error?: Error) => void }).destroy?.(
          new Error("下载超过字节上限"),
        );
      }
    });
    await params.pipeline(nodeStream, params.createWriteStream(params.dest));
    return !exceeded;
  } catch {
    return false;
  }
}
