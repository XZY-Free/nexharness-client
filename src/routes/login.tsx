import { useEffect } from "react";
import { authCenterBaseUrl } from "../lib/runtime-config";

/**
 * 登录入口（302 壳，搬迁自 nexharness app/login/page.tsx）。
 *
 * SPA 不提供登录表单：直接跳到 auth-center 门户（`{auth-center}/login?returnTo=`），
 * 登录完成后回跳本地址并附 `?ticket=`，由引导逻辑 /api/session/exchange 落地会话。
 */

function safeReturnTo(value: string | null): string {
  if (!value) return "/chat";
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/chat";
}

export default function LoginRoute() {
  useEffect(() => {
    const returnTo = safeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
    const absolute = `${window.location.origin}${returnTo}`;
    window.location.replace(
      `${authCenterBaseUrl()}/login?returnTo=${encodeURIComponent(absolute)}`,
    );
  }, []);
  return null;
}
