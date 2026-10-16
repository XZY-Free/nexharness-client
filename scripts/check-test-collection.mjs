#!/usr/bin/env node
/**
 * 测试收集完整性校验。
 *
 * 背景：vitest 在高负载（并行 worker 抢 CPU/磁盘）下曾出现**静默少收集测试文件**——
 * 全量跑报 43 文件 / 751 用例而实际有 46 文件 / 778 用例，退出码仍为 0。
 * 这类"假绿"会让 CI 漏测。
 *
 * 做法：
 * 1. 扫描磁盘上的 *.test.ts / *.test.tsx（排除构建产物与依赖）
 * 2. 用 vitest 的 json reporter 跑一次，读取实际被收集的文件列表
 * 3. 两者对比：磁盘有而实际未收集 → 报错退出 1
 *
 * 用法：node scripts/check-test-collection.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["lib", "components", "desktop", "src"];
const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  "package-app",
  "renderer-dist",
  "bundle",
  "release",
]);
const REPORT_PATH = join(ROOT, ".vitest-collection-check.json");

/** 递归收集磁盘上的测试文件（相对仓库根路径）。 */
function scanDisk() {
  const found = [];
  const walk = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      const child = join(absolute, entry);
      let isDir = false;
      try {
        isDir = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(child);
      } else if (/\.(test|spec)\.(ts|tsx)$/.test(entry)) {
        found.push(relative(ROOT, child));
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir));
  return found.sort();
}

/** 跑 vitest 并读回它实际收集到的文件列表。 */
function collectByVitest() {
  execFileSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${REPORT_PATH}`], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
  const files = new Set(
    (report.testResults ?? []).map((r) => relative(ROOT, r.name ?? "")).filter(Boolean),
  );
  return files;
}

const onDisk = scanDisk();
if (onDisk.length === 0) {
  console.error("[check-test-collection] 磁盘上未找到任何测试文件 —— include glob 可能已被改坏");
  process.exit(1);
}

let collected;
try {
  collected = collectByVitest();
} finally {
  rmSync(REPORT_PATH, { force: true });
}

const missing = onDisk.filter((f) => !collected.has(f));
if (missing.length > 0) {
  console.error(
    `[check-test-collection] ${missing.length} 个测试文件未被 vitest 收集（静默漏跑）：`,
  );
  for (const f of missing) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`[check-test-collection] OK：磁盘 ${onDisk.length} 个测试文件全部被收集`);
