/**
 * WebContents 事件接线（从 browser-controller 抽出，原 100 行方法）。
 *
 * 职责：把 Electron WebContents 的生命周期事件桥接到**已抽出的纯策略函数**
 * （checkUrlSafety / decidePermission / decidePopup / decideCertificateError）
 * 与状态更新回调。
 *
 * 设计：**依赖注入** —— 本模块不持有 BrowserController，也不直接读 store；
 * 通过 `WebContentsWiringDeps` 回调把状态写入交给调用方。因此：
 * - 可单测：`registerWebContentsHandlers(fakeWc, deps, ids)` 传事件替身即可
 *   （无需真实 Electron）
 * - 也可在真实 Electron 中端到端验证（见 e2e/browser-controller.electron.cjs）
 *
 * 安全口径（fail-closed）：
 * - 弹窗一律 deny（对受信任 origin 由 renderer 处理，不在外部浏览器打开）
 * - 证书错误默认不信任（除非 decideCertificateError 明确 trust）
 * - will-navigate / will-frame-navigate：**非 http/https 一律 preventDefault**；
 *   http/https 再交 checkUrlSafety 判定。外部协议（mailto/tel/custom）默认拒绝——
 *   它们既不是页面导航目标，也不是本窗口能安全渲染的内容，放行等于让页面在
 *   WebContentsView 内触发任意系统 handler。
 * - 权限请求按 decidePermission 决定
 */
import type { PermissionType } from "./permission-policy";
import { checkUrlSafety, decideCertificateError, decidePermission } from "./permission-policy";

/** 仅 http/https 允许在 WebContentsView 内导航；其余协议（含 mailto/tel/custom）一律拒绝。 */
function isHttpNavigation(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** 状态更新负载（与 TabStore.updateTab 的 patch 形状对齐的子集）。 */
export interface TabStatePatch {
  loadState?: "idle" | "loading" | "loaded" | "crashed";
  url?: string;
  title?: string;
  favicon?: string | null;
  canGoBack?: boolean;
  canGoForward?: boolean;
  error?: string;
}

/** 接线依赖（全部注入，便于测试）。 */
export interface WebContentsWiringDeps {
  /** 更新 tab 状态。 */
  updateTab: (patch: TabStatePatch) => void;
  /** 记录 webContents.id → (threadId, tabId) 反向索引（下载归属用）。 */
  indexWebContents: (webContentsId: number) => void;
  /** 在 session 上注册 will-download（调用方内部去重）。 */
  setupDownloadHandler: (session: unknown) => void;
  /** CDP 事件路由（Runtime.consoleAPICalled / Network.* 等）。 */
  handleCdpEvent: (method: string, params: unknown) => void;
}

/** Electron WebContents 的最小接口（便于测试替身）。 */
export interface WebContentsLike {
  readonly id: number;
  readonly session: unknown;
  getURL(): string;
  getTitle(): string;
  navigationHistory: { canGoBack(): boolean; canGoForward(): boolean };
  on(event: string, listener: (...args: never[]) => void): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}

/**
 * 注册 WebContents 的全部事件处理器。
 *
 * @param wc Electron WebContents（或其测试替身）
 * @param deps 注入的状态写入与路由回调
 */
export function registerWebContentsHandlers(
  wc: WebContentsLike,
  deps: WebContentsWiringDeps,
): void {
  // 反向索引（供 will-download 归属查找）
  deps.indexWebContents(wc.id);

  // Session 级 will-download 注册（调用方去重）
  deps.setupDownloadHandler(wc.session);

  // 导航开始 / 完成
  wc.on("did-start-loading", () => {
    deps.updateTab({ loadState: "loading" });
  });

  wc.on("did-stop-loading", () => {
    deps.updateTab({
      loadState: "loaded",
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    });
  });

  // 标题 / favicon
  wc.on("page-title-updated", ((_event: unknown, title: string) => {
    deps.updateTab({ title });
  }) as never);

  wc.on("page-favicon-updated", ((_event: unknown, favicons: string[]) => {
    deps.updateTab({ favicon: favicons[0] ?? null });
  }) as never);

  // 渲染进程崩溃
  wc.on("render-process-gone", ((_event: unknown, details: { reason?: string }) => {
    deps.updateTab({
      loadState: "crashed",
      error: details.reason || "render process crashed",
    });
  }) as never);

  // 权限请求：按 decidePermission 决定（handler 内用传入的 webContents 而非闭包）
  (
    wc.session as {
      setPermissionRequestHandler?: (
        h: (
          webContents: { getURL(): string },
          permission: string,
          cb: (granted: boolean) => void,
        ) => void,
      ) => void;
    }
  ).setPermissionRequestHandler?.((webContents, permission, callback) => {
    const decision = decidePermission(permission as PermissionType, webContents.getURL());
    callback(decision === "granted");
  });

  // 弹窗：一律 deny（受信任 origin 由 renderer 处理，不在外部浏览器打开）
  wc.setWindowOpenHandler((_details) => ({ action: "deny" }));

  // 证书错误：fail-closed
  wc.on("certificate-error", ((
    _event: unknown,
    _url: string,
    error: string,
    certificate: unknown,
    callback: (trust: boolean) => void,
  ) => {
    const decision = decideCertificateError(certificate, error);
    callback(decision === "trust");
  }) as never);

  // 导航拦截：主 frame + 子 frame 双覆盖。
  // 先排除非 http/https（prompt 类外部协议不能留在本窗口内渲染），
  // 再对 http/https 按 checkUrlSafety 拦截 blocked scheme。
  wc.on("will-navigate", ((event: { preventDefault(): void }, url: string) => {
    if (!isHttpNavigation(url) || checkUrlSafety(url) === "blocked") event.preventDefault();
  }) as never);

  wc.on("will-frame-navigate", ((details: { url: string; preventDefault(): void }) => {
    if (!isHttpNavigation(details.url) || checkUrlSafety(details.url) === "blocked") {
      details.preventDefault();
    }
  }) as never);

  // CDP 事件（始终注册，仅在 debugger attached 时触发）。
  // 注意：归一化（normalizeCdpEvent）由 handleCdpEvent 内部完成，这里只做路由，
  // 避免重复归一。
  (
    wc as unknown as {
      debugger: { on(e: string, h: (ev: unknown, method: string, params: unknown) => void): void };
    }
  ).debugger.on("message", (_event, method, params) => {
    deps.handleCdpEvent(method, params);
  });
}
