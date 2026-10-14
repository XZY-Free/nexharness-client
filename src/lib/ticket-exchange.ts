/**
 * 票据落地（消费方登录回跳）。
 *
 * auth-center 登录完成后把用户回跳到 SPA 地址并附 `?ticket=`；
 * SPA 引导时先兑换票据：POST nexharness `/api/session/exchange`
 * （服务端向 auth-center resolve 一次性票据并落地 HttpOnly 会话 cookie），
 * 成功后从地址栏抹掉 ticket；失败回到 /login 重新走登录。
 */
import { apiFetch, apiPath } from "@/lib/api-fetch";

export async function exchangeTicketIfPresent(): Promise<void> {
  const url = new URL(window.location.href);
  const ticket = url.searchParams.get("ticket");
  if (!ticket) return;

  try {
    const response = await apiFetch("/api/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (response.ok) {
      url.searchParams.delete("ticket");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      return;
    }
  } catch {
    /* 网络失败 → 走重新登录路径。 */
  }

  const returnTo = `${url.pathname}${url.search}`;
  window.location.replace(`${apiPath("/login")}?returnTo=${encodeURIComponent(returnTo)}`);
}
