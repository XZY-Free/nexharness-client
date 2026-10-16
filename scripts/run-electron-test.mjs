#!/usr/bin/env node
/**
 * Electron 测试 harness。
 *
 * 用途：在真实 Electron 里跑断言脚本，验证 browser-controller 这类
 * **强 Electron 耦合**的逻辑（contentView 操作、webContents 生命周期、session 事件）。
 *
 * 背景（两个环境陷阱，必须绕过，否则 Electron 会"降级成 Node"或启动失败）：
 * 1. `ELECTRON_RUN_AS_NODE=1` —— 宿主进程（WorkBuddy 自身是 Electron 应用）注入，
 *    **会传染给所有子进程**。带着它启动时 `require("electron")` 返回的是**路径字符串**
 *    而非模块（`app` 为 undefined），看起来像"Electron 不可用"。
 *    → 必须 `env -u ELECTRON_RUN_AS_NODE`。
 * 2. 沙箱初始化失败（`sandbox initialization failed: Operation not permitted`）+
 *    GPU 进程崩溃（`GPU process isn't usable. Goodbye.`）。
 *    → 必须 `--no-sandbox --disable-gpu --disable-software-rasterizer --in-process-gpu`。
 *
 * 用法：
 *   node scripts/run-electron-test.mjs <script.cjs> [--timeout=30000]
 * 或在测试脚本里 require 本模块导出的 helper（若以 Electron 启动）。
 *
 * 退出码：0 = 全部断言通过；1 = 有失败；2 = 超时；3 = 启动失败。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Electron 可执行文件路径（直接用 dist 里的二进制，绕开 cli.js 的 spawn 层）。 */
export function electronBinary() {
  const candidates = [
    join(ROOT, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    join(ROOT, "node_modules/electron/dist/electron"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("找不到 Electron 可执行文件：请先运行 `node node_modules/electron/install.js`");
}

/** Electron 启动所需的最小参数（绕开沙箱与 GPU 问题）。 */
export const ELECTRON_FLAGS = [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--in-process-gpu",
];

/**
 * 在真实 Electron 里运行脚本。
 *
 * @param {string} scriptPath 目标脚本（.cjs，CommonJS，可 require 编译产物）
 * @param {{ timeoutMs?: number, extraArgs?: string[], env?: Record<string,string> }} opts
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function runInElectron(scriptPath, opts = {}) {
  const { timeoutMs = 60_000, extraArgs = [], env = {} } = opts;
  const bin = electronBinary();

  // 关键：剔除 ELECTRON_RUN_AS_NODE，否则 Electron 会降级成 Node。
  // 用显式构造而非 delete（biome 禁 delete；且赋 undefined 会让 spawn 传字符串
  // "undefined"，环境变量仍在 → 仍会降级）。
  const childEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE"),
  );

  return new Promise((resolvePromise) => {
    const child = spawn(bin, [...ELECTRON_FLAGS, ...extraArgs, resolve(scriptPath)], {
      cwd: ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({
        code: 2,
        stdout,
        stderr: `${stderr}\n[harness] TIMEOUT after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

// ─── CLI ────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const [, , script, ...rest] = process.argv;
  if (!script) {
    console.error("用法: node scripts/run-electron-test.mjs <script.cjs> [--timeout=30000]");
    process.exit(3);
  }
  const timeoutArg = rest.find((a) => a.startsWith("--timeout="));
  const timeoutMs = timeoutArg ? Number(timeoutArg.split("=")[1]) : 60_000;

  const result = await runInElectron(script, { timeoutMs });
  process.stdout.write(result.stdout);
  if (result.stderr.trim()) process.stderr.write(result.stderr);
  process.exit(result.code);
}
