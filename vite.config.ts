import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * nexharness-client Web SPA 构建配置。
 *
 * - base：部署子路径（NEX_BASE_PATH，默认 "/"）；与 apiPath 的注入源保持一致。
 * - dev 代理：/api、/admin/api、/studio/api、/preview → nexharness（默认 :3210）。
 *
 * 历史：本仓曾把 next/link、next/navigation 别名到自建 shim（从 Next.js 搬迁期的兼容层）。
 * 现已全部改用 react-router 原生 API，shim 与别名均已移除。BASE_URL 前缀由
 * BrowserRouter 的 basename 承担（见 src/app.tsx），因此 Link 直接用应用内路径即可。
 */
const base = process.env.NEX_BASE_PATH ?? "/";

export default defineConfig({
  base,
  define: {
    "process.env.NEXT_PUBLIC_NEX_BASE_PATH": JSON.stringify(
      base === "/" ? "" : base.replace(/\/$/, ""),
    ),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname),
    },
  },
  esbuild: { jsx: "automatic" },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3210",
      "/admin/api": "http://localhost:3210",
      "/studio/api": "http://localhost:3210",
      "/preview": "http://localhost:3210",
    },
  },
});
