/**
 * 截图落盘规则（从 browser-controller 抽出）。
 *
 * 抽出价值：**文件权限是安全点** —— 截图可能含敏感页面内容，必须以 0600 写入
 * （仅 owner 可读写）。原先内联在方法里只有一句注释，现在有断言固化。
 * 另外文件名/扩展名映射（jpeg→jpg，其余→png）也是可测规则。
 */
import * as os from "node:os";
import * as path from "node:path";

/** 截图文件权限：仅 owner 可读写（防本机其他用户读取截图）。 */
export const SCREENSHOT_FILE_MODE = 0o600;

/** 允许的截图格式。 */
export type ScreenshotFormat = "png" | "jpeg";

/**
 * 归一截图格式：只有精确 "jpeg" 才当 jpeg，其余一律 png（安全默认）。
 */
export function normalizeScreenshotFormat(format: string): ScreenshotFormat {
  return format === "jpeg" ? "jpeg" : "png";
}

/** 格式 → 扩展名（jpeg → jpg，其余 → png）。 */
export function screenshotExtension(format: string): "jpg" | "png" {
  return normalizeScreenshotFormat(format) === "jpeg" ? "jpg" : "png";
}

/**
 * 生成截图文件路径（临时目录）。
 *
 * 文件名含 threadId/tabId/时间戳：避免不同 tab 相互覆盖，也便于排查。
 * 注意时间戳使文件名不可预测（不作为安全边界，权限才是）。
 *
 * 标识符净化：threadId / tabId 来自 RPC 信封，schema 只约束「非空字符串」，
 * 若含 `/`、`\`、`..` 即可让 `path.join` 逃出临时目录（写入任意路径）。
 * 因此这里只保留 `[A-Za-z0-9_-]`，其余字符替换为 `_`。
 */
export function sanitizeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function screenshotFilePath(params: {
  readonly threadId: string;
  readonly tabId: string;
  readonly format: string;
  readonly now: number;
  readonly tmpDir?: string;
}): string {
  const ext = screenshotExtension(params.format);
  const filename = `screenshot-${sanitizeFileToken(params.threadId)}-${sanitizeFileToken(
    params.tabId,
  )}-${params.now}.${ext}`;
  return path.join(params.tmpDir ?? os.tmpdir(), filename);
}
