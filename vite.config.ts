import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * nexharness-client Web SPA 构建配置。
 *
 * - base：部署子路径（NEX_BASE_PATH，默认 "/"）；与 apiPath 的注入源保持一致。
 * - next/link、next/navigation：别名到 react-router shim（tsconfig paths 同步映射，
 *   使 tsc 与 Vite 双解析一致——搬迁面零改源）。
 * - dev 代理：/api、/admin/api、/studio/api、/preview → nexharness（默认 :3210）。
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
      "next/link": resolve(__dirname, "src/shims/next-link.tsx"),
      "next/navigation": resolve(__dirname, "src/shims/next-navigation.ts"),
    },
  },
  esbuild: { jsx: "automatic" },
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        // "use client" 等在 Vite 下为无副作用指令，忽略模块级指令告警。
        if (warning.code === "MODULE_LEVEL_DIRECTIVE" || warning.code === "SOURCEMAP_ERROR") return;
        warn(warning);
      },
    },
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
