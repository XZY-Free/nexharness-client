import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 单元测试配置（vitest）。
 *
 * 覆盖范围：不依赖 electron / 浏览器 / 服务端的纯逻辑模块——
 * origin 守卫、脱敏、签名、RPC 安全、CDP 输入、Thread 投影 reducer 等。
 * 需要真实服务端与 UI 的链路走 Playwright E2E（见 playwright.config.ts）。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname),
    },
  },
  test: {
    environment: "node",
    include: ["{src,components,lib,desktop}/**/*.{test,spec}.{ts,tsx}"],
    // React hooks 测试需要 DOM：在文件顶部加 `// @vitest-environment jsdom` 单文件切换
    // （不打全局 jsdom，避免拖慢纯逻辑用例）。
    exclude: [
      "node_modules/**",
      "dist/**",
      "desktop/package-app/**",
      "desktop/renderer-dist/**",
      "desktop/bundle/**",
      "release/**",
      "e2e/**",
    ],
    /**
     * 限制 worker 数（原本为 CPU 核数）。
     *
     * 实测：不限并发时，jsdom 环境的 hooks 测试（components/hooks/*.test.ts）会在
     * worker 竞争下**环境初始化失败并被静默跳过** —— 全量跑稳定少收集 4 个文件
     * （47/822 而非 51/856），退出码仍为 0（假绿）。
     *
     * 限制到 2 后 51/856 稳定全收集。当前 51 个文件的规模下，并发收益远小于
     * "漏测却不报错"的代价。（`pnpm test` 已内置收集校验，本项是根治。）
     */
    maxWorkers: 2,
    minWorkers: 1,
  },
});
