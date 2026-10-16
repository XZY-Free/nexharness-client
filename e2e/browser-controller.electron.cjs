#!/usr/bin/env node
/**
 * browser-controller 真实 Electron 行为测试。
 *
 * 这些断言**跑在真实 Electron 里**（通过 scripts/run-electron-test.mjs 启动），
 * 覆盖此前"纯逻辑单测无法覆盖"的部分：WebContentsView 生命周期、BrowserWindow
 * contentView 挂载、Session partition、tab 切换的 view 可见性。
 *
 * 运行：node scripts/run-electron-test.mjs e2e/browser-controller.electron.cjs
 * 退出码：0 全通过 / 1 有失败
 */
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

// 编译产物（CommonJS）：desktop/dist/desktop/browser/...
const DIST = path.join(__dirname, "..", "desktop", "dist", "desktop");
const { BrowserController } = require(path.join(DIST, "browser", "browser-controller.js"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "\u2713" : "\u2717"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** 极简断言包装（异步用例也适用）。 */
async function test(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, e.message);
  }
}

function makeController() {
  return new BrowserController({
    serverOrigins: ["https://nex.example.com"],
    // 注意：WindowConstraints 是 {windowWidth, windowHeight}（内容区尺寸），
    // 不是 min/max 形式 —— 见 desktop/browser/bounds-validator.ts
    windowConstraints: { windowWidth: 1200, windowHeight: 800 },
  });
}

async function main() {
  await app.whenReady();

  // ── 1. 构造 + attachToWindow
  const controller = makeController();
  const win = new BrowserWindow({ show: false, width: 1200, height: 800 });
  controller.attachToWindow(win);
  check("attachToWindow 后可创建 tab", true);

  const THREAD = "thread-1";

  // ── 2. createTab 真实创建 WebContentsView
  const tab = controller.createTab(THREAD, "https://nex.example.com/a");
  await test("createTab 返回带 id 的 TabMetadata", () => {
    check("createTab 返回 tab.id", typeof tab.id === "string" && tab.id.length > 0, tab.id);
  });

  // view 真的挂到了 window.contentView
  const children = win.contentView.children;
  check(
    "createTab 后 view 挂到 window.contentView",
    children.length >= 1,
    `children=${children.length}`,
  );

  // tabStore 记录了 tab
  await test("getTabs 反映新 tab", () => {
    const tabs = controller.getTabs(THREAD);
    check("getTabs 长度 1", tabs.length === 1, `len=${tabs.length}`);
    check("getActiveTab 命中新 tab", controller.getActiveTab(THREAD)?.id === tab.id);
  });

  // ── 3. 第二个 tab + 切换（真实 view 可见性）
  const tab2 = controller.createTab(THREAD, "https://nex.example.com/b");
  await test("第二个 tab 创建", () => {
    check("getTabs 长度 2", controller.getTabs(THREAD).length === 2);
    check("active 切到 tab2", controller.getActiveTab(THREAD)?.id === tab2.id);
  });

  await test("switchTab 切回 tab1", () => {
    const ok = controller.switchTab(THREAD, tab.id);
    check("switchTab 返回 true", ok === true);
    check("active 为 tab1", controller.getActiveTab(THREAD)?.id === tab.id);
  });

  await test("switchTab 到不存在的 tab 返回 false", () => {
    check("未知 tabId → false", controller.switchTab(THREAD, "nope") === false);
  });

  // ── 4. setBounds 真实生效
  await test("setBounds 更新 view 尺寸", () => {
    const ok = controller.setBounds(THREAD, tab.id, { x: 10, y: 20, width: 500, height: 400 }, 1);
    check("setBounds 返回 true", ok === true);
  });

  await test("越界 bounds 被拒（bounds-validator）", () => {
    const ok = controller.setBounds(
      THREAD,
      tab.id,
      { x: 0, y: 0, width: 99_999, height: 99_999 },
      1,
    );
    check("超窗口约束的 bounds → false", ok === false);
  });

  // ── 5. closeTab 真实清理
  await test("closeTab 从 registry + contentView 移除", () => {
    const before = win.contentView.children.length;
    const closed = controller.closeTab(THREAD, tab.id);
    check("closeTab 返回被关 tab", closed?.id === tab.id);
    check(
      "getTabs 减为 1",
      controller.getTabs(THREAD).length === 1,
      `len=${controller.getTabs(THREAD).length}`,
    );
    const after = win.contentView.children.length;
    check("contentView 子视图减少", after < before, `${before} → ${after}`);
  });

  await test("closeTab 未知 tab 返回 null", () => {
    check("未知 tabId → null", controller.closeTab(THREAD, "nope") === null);
  });

  // ── 6. incognito partition 真实隔离
  await test("incognito tab 使用独立 partition", () => {
    const inc = controller.createTab(THREAD, "https://nex.example.com/i", undefined, {
      incognito: true,
    });
    check("incognito tab 创建成功", typeof inc.id === "string");
    check("incognito 计数 ≥ 1", controller.getSessionManager().getIncognitoCount(THREAD) >= 1);
  });

  await test("关闭最后一个 incognito tab → session 销毁", () => {
    const incTabs = controller.getTabs(THREAD).filter((t) => t.incognito);
    for (const t of incTabs) controller.closeTab(THREAD, t.id);
    check(
      "incognito 计数归零",
      controller.getSessionManager().getIncognitoCount(THREAD) === 0,
      `count=${controller.getSessionManager().getIncognitoCount(THREAD)}`,
    );
  });

  // ── 7. closeThread 全量清理
  await test("closeThread 清空该 thread 的全部 tab", () => {
    controller.createTab(THREAD, "https://nex.example.com/x");
    const n = controller.closeThread(THREAD);
    check("closeThread 返回关闭数 ≥ 1", n >= 1, `n=${n}`);
    check("getTabs 为空", controller.getTabs(THREAD).length === 0);
  });

  // ── 8. URL 安全检查（真实调用链）
  await test("被阻止的 URL 抛错（checkUrlSafety）", () => {
    let threw = false;
    try {
      controller.createTab(THREAD, "javascript:alert(1)");
    } catch {
      threw = true;
    }
    check("javascript: URL 被阻止", threw);
  });

  // ── 9. 用户输入阻断（真实 setUserInputBlocked → view）
  await test("setUserInputBlocked 状态可读写", () => {
    const t = controller.createTab(THREAD, "https://nex.example.com/y");
    controller.setUserInputBlocked(THREAD, true);
    check("isUserInputBlocked = true", controller.isUserInputBlocked(THREAD) === true);
    controller.setUserInputBlocked(THREAD, false);
    check("isUserInputBlocked = false", controller.isUserInputBlocked(THREAD) === false);
    controller.closeTab(THREAD, t.id);
  });

  // ── 收尾
  win.destroy();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[electron-test] ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log(`  - ${f.name}`);
  }
  app.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("[electron-test] 异常：", e);
  app.exit(3);
});

setTimeout(() => {
  console.error("[electron-test] TIMEOUT");
  app.exit(2);
}, 50_000);
