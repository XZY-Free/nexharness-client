#!/usr/bin/env node
/**
 * 给 desktop 编译产物目录写 `package.json`（type: commonjs）。
 *
 * 原因：仓库根 package.json 是 `"type": "module"`，而 desktop 的 tsc 产物是
 * CommonJS（`exports.x = ...`）。若不加此标记，Electron 会按 ESM 解析产物并报
 * `exports is not defined in ES module scope`。
 *
 * 由 test:electron 与 build:desktop 调用（幂等）。
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "desktop", "dist");

if (!existsSync(DIST)) {
  console.error("[ensure-dist-cjs] desktop/dist 不存在，请先运行 tsc -p desktop/tsconfig.json");
  process.exit(1);
}
writeFileSync(join(DIST, "package.json"), '{\n  "type": "commonjs"\n}\n', "utf8");
console.log("[ensure-dist-cjs] OK: desktop/dist/package.json → commonjs");
