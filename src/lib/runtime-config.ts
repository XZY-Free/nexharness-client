/**
 * 客户端运行时配置（构建期注入；默认对齐本地 dev 联调端口）。
 *
 * - VITE_NEX_AUTH_CENTER_URL：auth-center 对外地址（登录跳转入口用）。
 * - VITE_NEX_API_ORIGIN：预留（独立部署时 API 绝对地址；当前同源/代理模式不需要）。
 */
export function authCenterBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_NEX_AUTH_CENTER_URL as string | undefined;
  return (fromEnv ?? "http://localhost:3101").replace(/\/+$/, "");
}
