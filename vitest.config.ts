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
      "next/link": resolve(__dirname, "src/shims/next-link.tsx"),
      "next/navigation": resolve(__dirname, "src/shims/next-navigation.ts"),
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
  },
});
