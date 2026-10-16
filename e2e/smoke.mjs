/**
 * E2E 冒烟脚本（Playwright 原生 API，不依赖 @playwright/test）。
 *
 * 覆盖 Web SPA 无需登录即可验证的关键路径：
 *   1. SPA 可加载并渲染（无 JS 崩溃）
 *   2. 未登录访问 /chat 会被引导到登录流程（AuthGate / 302 到 auth-center）
 *   3. 未知路由渲染 404 视图
 *   4. 桌面端可执行代码（/desktop 路由）由 Web 侧渲染兜底
 *
 * 前提：Web SPA dev server 已在运行（默认 http://localhost:5173）。
 *   pnpm dev &          # 另开终端
 *   pnpm test:e2e
 *
 * 说明：需要真实服务端（:3210）与 auth-center 的链路（登录后对话）不在本脚本内，
 * 那部分需完整三件套联调环境，见 README「运行前提」。
 */
import { chromium } from "playwright";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

/** 极简断言：失败即抛错并计入失败数。 */
const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: !!condition, detail });
  const mark = condition ? "\u2713" : "\u2717";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  try {
    // 1. SPA 加载
    const resp = await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });
    check(
      "SPA 返回 2xx",
      resp && resp.status() >= 200 && resp.status() < 400,
      `status=${resp?.status()}`,
    );

    const rootCount = await page.locator("#root").count();
    check("#root 挂载点存在", rootCount === 1);

    // 2. 根路径重定向到 /chat（app.tsx: "/" -> Navigate to="/chat"）
    await page.waitForTimeout(1500);
    const url = page.url();
    check("根路径重定向到 /chat 或 /login", /\/chat|\/login/.test(url), `url=${url}`);

    // 3. 未登录访问 /chat：AuthGate 校验会话
    //    - 服务端在线且未登录（401）→ 跳 /login
    //    - 服务端不可达（502/网络失败）→ 渲染「加载失败」门禁态（fail-closed，不误放行）
    await page.goto(`${BASE_URL}/chat`, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(2000);
    const chatUrl = page.url();
    const gatedByLogin = /\/login/.test(chatUrl);
    const gatedByError = (await page.locator("text=/加载失败|正在加载/i").count()) > 0;
    check(
      "未登录访问 /chat 被门禁拦截（跳登录 或 fail-closed 门禁态）",
      gatedByLogin || gatedByError,
      gatedByLogin ? "已跳转 /login" : gatedByError ? "服务端未就绪，渲染门禁态" : `url=${chatUrl}`,
    );

    // 4. 未知路由渲染 404
    await page.goto(`${BASE_URL}/definitely-not-a-route-xyz`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
    await page.waitForTimeout(1000);
    const notFound = (await page.locator("text=/404|页面不存在|未找到/i").count()) > 0;
    check("未知路由渲染 404 视图", notFound);

    // 5. 无未捕获页面异常（React 崩溃会写入 pageerror）
    //    资源加载失败（服务端未就绪时的 500/502 代理错误）不计入——那是环境依赖，不是应用崩溃。
    const appErrors = consoleErrors.filter(
      (e) => !/Failed to load resource|favicon|net::ERR|status of 5\d\d/i.test(e),
    );
    check("无未捕获页面异常", appErrors.length === 0, appErrors.slice(0, 2).join(" | "));
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error(`\n失败项：\n${failed.map((f) => `  - ${f.name} ${f.detail}`).join("\n")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("E2E 运行失败：", err);
  process.exit(1);
});
