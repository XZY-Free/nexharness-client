/**
 * 页面快照（结构化 DOM 摘要 + 可见文本）—— 从 browser-controller 抽出。
 *
 * 抽出价值：
 * 1. 页面内脚本是**注入面**：本模块不拼接任何外部输入（脚本为固定字面量），
 *    并把"只用结构化摘要、不返回原始 HTML"这一约束写在注释里防回退
 * 2. 结果解析与文本截断是**纯逻辑**，可单测（含截断边界、畸形返回）
 * 3. 只依赖 SnapshotTargetLike 接口 → 替身可测
 */

/** CDP 目标最小接口。 */
export interface SnapshotTargetLike {
  sendCommand(method: string, params: unknown): Promise<{ ok: boolean; result?: unknown }>;
}

/** 快照结果。 */
export interface PageSnapshot {
  text: string;
  domSummary: string;
}

/**
 * 在页面上下文执行的采集脚本（**固定字面量，不含任何外部输入**）。
 *
 * 安全约束（勿改）：
 * - 只返回 innerText 与结构化计数/表单信息，**绝不返回原始 HTML**
 *   （避免把整页 HTML 发给模型，既有体积也有泄漏面）
 * - 无 body 时返回空结构（不是抛错，保证调用方拿到可用值）
 */
export const SNAPSHOT_EXPRESSION = `(function() {
        const body = document.body;
        if (!body) return JSON.stringify({ text: '', domSummary: '{}' });
        const text = body.innerText || '';
        const forms = Array.from(document.querySelectorAll('form')).map(f => ({
          action: f.action || '',
          method: f.method || 'get',
          fieldCount: f.elements.length
        }));
        const linkCount = document.querySelectorAll('a[href]').length;
        const formCount = document.querySelectorAll('form').length;
        const inputCount = document.querySelectorAll('input').length;
        const imgCount = document.querySelectorAll('img').length;
        const meta = {
          title: document.title || '',
          url: location.href,
          forms,
          linkCount,
          formCount,
          inputCount,
          imgCount
        };
        return JSON.stringify({ text, domSummary: JSON.stringify(meta) });
      })()`;

/**
 * 按最大长度截断文本。
 *
 * 规则：仅当给了正数上限且确实超长时截断；截断后总长为 maxTextLength
 * （用 `...` 占 3 字符）。null/undefined/0/负数 → 不截断。
 */
export function truncateSnapshotText(text: string, maxTextLength?: number | null): string {
  if (!maxTextLength || maxTextLength <= 0 || text.length <= maxTextLength) return text;
  return `${text.slice(0, maxTextLength - 3)}...`;
}

/**
 * 解析 `Runtime.evaluate` 的返回为 PageSnapshot。
 *
 * fail-closed：ok=false / result 缺失 / value 非字符串 / JSON 非法 /
 * 解析结果形状不对 → 返回 null（调用方据此判定快照失败）。
 */
export function parseSnapshotResult(result: {
  ok: boolean;
  result?: unknown;
}): PageSnapshot | null {
  if (!result.ok || !result.result) return null;
  const value = (result.result as { result?: { value?: unknown } }).result?.value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { text?: unknown }).text !== "string" ||
      typeof (parsed as { domSummary?: unknown }).domSummary !== "string"
    ) {
      return null;
    }
    return parsed as PageSnapshot;
  } catch {
    return null;
  }
}

/**
 * 采集页面快照（组合：发命令 → 解析 → 截断）。
 */
export async function capturePageSnapshot(
  target: SnapshotTargetLike,
  maxTextLength?: number,
): Promise<PageSnapshot | null> {
  const raw = await target.sendCommand("Runtime.evaluate", {
    expression: SNAPSHOT_EXPRESSION,
    returnByValue: true,
  });
  const parsed = parseSnapshotResult(raw);
  if (!parsed) return null;
  return { ...parsed, text: truncateSnapshotText(parsed.text, maxTextLength) };
}
