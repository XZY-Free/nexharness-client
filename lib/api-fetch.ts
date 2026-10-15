/** 构建时内联的 basePath（如 "/nexharness"），未设置时为空串。 */
const BASE_PATH = process.env.NEXT_PUBLIC_NEX_BASE_PATH ?? "";

/**
 * 给应用内 API 路径拼 basePath 前缀。
 *
 * 防御规则：
 * - 仅处理 "/" 开头的同源路径；绝对 URL（http...）原样返回。
 * - 已带前缀的路径原样返回，避免双重拼接。
 */
export function apiPath(path: string): string {
  if (!BASE_PATH) return path;
  if (!path.startsWith("/")) return path;
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  return `${BASE_PATH}${path}`;
}

/**
 * fetch 包装：自动拼 basePath。仅覆盖"字符串路径 + 可选 init"场景（本仓库全部用法）。
 * 返回值与签名和全局 fetch 保持一致，可直接替换裸 fetch 调用。
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiPath(path), init);
}
