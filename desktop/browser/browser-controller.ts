/**
 * Browser Controller。
 *
 * 管理 WebContentsView 的完整生命周期：
 * - 创建/销毁 WebContentsView
 * - 创建/关闭 tab
 * - 导航（navigate/back/forward/reload/stop）
 * - 设置 bounds（resize）
 * - 切换 active tab（显示/隐藏 view）
 * - 应用 permission/popup/protocol 策略
 * - 管理 Session partition
 *
 * 依赖 electron 的 WebContentsView、Session、BrowserWindow。
 * 核心逻辑委托给 TabStore、ViewRegistry、SessionManager 等纯逻辑模块。
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type BrowserWindow, type Session, WebContentsView, session } from "electron";
import { cleanupAllTempFiles, cleanupThreadTempFiles, safeUnlink } from "../artifacts/temp-cleanup";
import { TempFileRegistry } from "../artifacts/temp-file-registry";
import type { DownloadManager, DownloadRecord } from "../downloads/download-manager";
import { type UploadConfig, uploadFileToWorkspace } from "../downloads/download-uploader";
import type { QaController } from "../qa/qa-controller";
import { boundsChanged, hiddenBounds, validateBounds } from "./bounds-validator";
import type { Bounds, WindowConstraints } from "./bounds-validator";
import { extractDocumentRootId, extractQueryNodeId, toCdpKeyCode } from "./cdp-input";
import { normalizeCdpEvent } from "./cdp-insights";
import { DebuggerSessionScheduler } from "./debugger-session-scheduler";
import type { DebuggerSessionTarget } from "./debugger-session-scheduler";
import { WebContentsDebuggerTarget } from "./debugger-target";
import {
  type DownloadCoordinatorDeps,
  type DownloadManagerLike,
  handleWillDownload,
} from "./download-coordinator";
import {
  type NavTargetLike,
  dispatchNavAction,
  normalizeUrl,
  validateNavAction,
} from "./nav-actions";
import type { BrowserNavAction } from "./nav-actions";
import { PageInsightsStore } from "./page-insights-store";
import { checkUrlSafety } from "./permission-policy";
import type { PermissionType } from "./permission-policy";
import { SessionManager } from "./session-manager";
import { decideCloseTab } from "./tab-lifecycle";
import type { TabRestore } from "./tab-restore";
import { TabStore } from "./tab-store";
import type { TabId, TabMetadata, ThreadId } from "./tab-store";
import { ViewRegistry } from "./view-registry";
import { type WebContentsLike, registerWebContentsHandlers } from "./web-contents-wiring";

/** 默认可见 bounds（首次显示时使用） */
const DEFAULT_VISIBLE_BOUNDS: Bounds = { x: 0, y: 80, width: 1400, height: 820 };

/**
 * Browser Controller 配置。
 */
export interface BrowserControllerConfig {
  /** 受信任 NexHarness Server origin 列表 */
  serverOrigins: string[];
  /** 窗口尺寸约束（用于 bounds 校验） */
  windowConstraints: WindowConstraints;
  /** Desktop 本地 SQLite tab 持久化。 */
  tabRestore?: TabRestore;
}

/**
 * Browser Controller - 管理所有 Thread 的 WebContentsView。
 *
 * 使用 BrowserWindow.contentView 管理子 view。
 * active view 显示在内容区，非 active view 隐藏到 1x1 bounds。
 */
export class BrowserController {
  private tabStore = new TabStore();
  private viewRegistry = new ViewRegistry<WebContentsView>();
  private sessionManager = new SessionManager();
  /** CDP 调试器会话调度器（引用计数 attach/detach） */
  private debuggerScheduler = new DebuggerSessionScheduler((threadId, tabId) => {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return null;
    return new WebContentsDebuggerTarget(view.webContents);
  });
  /** 每个 threadId:tabId 最后一次设置的 bounds（用于减少不必要的 setBounds 调用） */
  private lastBounds = new Map<string, Bounds>();
  private window: BrowserWindow | null = null;
  private config: BrowserControllerConfig;
  /** Phase 7-1：下载记录管理器（由 main/index.ts 注入，可能为 null 表示未启用） */
  private downloadManager: DownloadManager | null = null;
  /** Phase 7-1：下载上传配置（serverOrigin + 可选 authToken） */
  private downloadUploadConfig: UploadConfig | null = null;
  /** Phase 7-1：webContents.id → (threadId, tabId) 反向索引，用于 will-download 事件归属 */
  private webContentsIndex = new Map<number, { threadId: ThreadId; tabId: TabId }>();
  /** Phase 7-1：已注册 will-download handler 的 Session 集合（去重，避免重复监听） */
  private registeredDownloadSessions = new Set<Session>();
  /** Phase 7-3：页面洞察缓冲（Console / Network 事件按 thread+tab 隔离） */
  private pageInsightsStore = new PageInsightsStore();
  /** Phase 7-3：已启用 Runtime+Network 监控的 tab 集合（"threadId:tabId"），持有 debugger ref 防止 detach */
  private monitoringRefs = new Set<string>();
  /** Phase 7-6：临时文件注册表，跟踪 screenshot/download 待清理的本机文件 */
  private tempFileRegistry = new TempFileRegistry();
  /** Phase 8：隐藏 QA WebContents 控制器（可选注入，closeThread 时联动清理） */
  private qaController: QaController | null = null;
  private restoringThreads = new Set<ThreadId>();
  private inputBlockedThreads = new Set<ThreadId>();

  constructor(config: BrowserControllerConfig) {
    this.config = config;
    this.tabStore.subscribe((event) => {
      const threadId = "tab" in event ? event.tab.threadId : event.threadId;
      if (!this.restoringThreads.has(threadId)) this.persistTabs(threadId);
    });
  }

  /** 首次打开 Thread 时从本地 SQLite 惰性恢复普通 tabs。 */
  restoreTabs(threadId: ThreadId, userId: string): void {
    const tabRestore = this.config.tabRestore;
    if (!tabRestore || this.tabStore.getThreadState(threadId)) return;
    const restored = tabRestore.restoreThread(threadId);
    if (restored.tabs.length === 0) return;

    this.restoringThreads.add(threadId);
    try {
      for (const tab of restored.tabs) {
        this.createTab(threadId, tab.url, userId, {
          tabId: tab.id,
          activate: false,
        });
      }
      const activeTabId = restored.activeTabId ?? restored.tabs[0]?.id;
      if (activeTabId) this.switchTab(threadId, activeTabId);
    } finally {
      this.restoringThreads.delete(threadId);
    }
    this.persistTabs(threadId);
  }

  private persistTabs(threadId: ThreadId): void {
    const tabRestore = this.config.tabRestore;
    if (!tabRestore) return;
    tabRestore.persistTabs(
      threadId,
      this.tabStore.getTabs(threadId),
      this.tabStore.getActiveTab(threadId)?.id ?? null,
    );
  }

  /** 绑定到 BrowserWindow */
  attachToWindow(window: BrowserWindow): void {
    this.window = window;
  }

  /**
   * Phase 7-1：注入 DownloadManager。
   *
   * 注入后 BrowserController 会监听 Session 的 will-download 事件，
   * 自动捕获下载并跟踪进度，完成后流式上传到 Server workspace。
   */
  setDownloadManager(manager: DownloadManager): void {
    this.downloadManager = manager;
  }

  /**
   * Phase 7-1：配置下载上传参数。
   *
   * 下载完成后使用此配置调用 uploadFileToWorkspace 将本机文件上传到 Server。
   * 未配置时下载仍会被捕获并记录，但不会自动上传。
   */
  setDownloadUploadConfig(config: UploadConfig): void {
    this.downloadUploadConfig = config;
  }

  /**
   * Phase 8：注入 QaController（可选）。
   *
   * 注入后 closeThread 会联动调用 qaController.closeThread，
   * 确保 thread 关闭时隐藏 QA WebContents 和临时 session partition 被清理。
   */
  setQaController(qa: QaController): void {
    this.qaController = qa;
  }

  /**
   * Phase 7-1：列出 Thread 的下载记录。
   *
   * 委托给 DownloadManager.listDownloads，按 createdAt 降序返回。
   * DownloadManager 未注入时返回空数组。
   */
  listDownloads(threadId: ThreadId): DownloadRecord[] {
    if (!this.downloadManager) return [];
    return this.downloadManager.listDownloads(threadId);
  }

  /** 更新窗口约束（窗口 resize 时调用） */
  updateWindowConstraints(constraints: WindowConstraints): void {
    this.config.windowConstraints = constraints;
  }

  /**
   * 创建新 tab。
   * @param threadId - Thread ID
   * @param url - 初始 URL（空字符串则空白页）
   * @param userId - 用户 ID（用于 Session partition）。可选，缺省时使用 threadId 作为 partition 键，保证 Thread 隔离
   * @param opts - incognito/tabId/activate
   * @returns 创建的 tab 元数据
   */
  createTab(
    threadId: ThreadId,
    url: string,
    userId?: string,
    opts?: { incognito?: boolean; tabId?: string; activate?: boolean },
  ): TabMetadata {
    // 安全检查 URL
    if (url.length > 0) {
      const safety = checkUrlSafety(url);
      if (safety === "blocked") {
        throw new Error(`URL 被阻止: ${url}`);
      }
    }

    // 创建 tab 元数据
    const tab = this.tabStore.createTab(threadId, url, opts);

    // 获取或创建 Session partition
    // userId 为空时使用 threadId 作为 partition 键，保证不同 Thread 的 session 隔离
    const effectiveUserId = userId && userId.length > 0 ? userId : threadId;
    const partition = opts?.incognito
      ? this.sessionManager.createIncognitoPartition(threadId)
      : this.sessionManager.getOrCreateBrowserPartition(effectiveUserId);

    // 创建 WebContentsView
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });

    // 注册 view
    const activate = opts?.activate ?? true;
    this.viewRegistry.set(threadId, tab.id, view, activate);

    // 加入 BrowserWindow contentView
    this.window?.contentView.addChildView(view);

    if (activate) {
      this.showView(threadId, tab.id);
    } else {
      // 非 active，隐藏到 1x1
      view.setBounds(hiddenBounds());
    }

    // 导航到 URL
    if (url.length > 0) {
      const normalized = normalizeUrl(url);
      if (normalized) {
        void view.webContents.loadURL(normalized);
        this.tabStore.updateTab(threadId, tab.id, { loadState: "loading" });
      }
    }

    // 设置 WebContents 事件监听
    this.setupWebContentsEvents(threadId, tab.id, view);
    if (this.inputBlockedThreads.has(threadId)) {
      void this.setTabInputBlocked(threadId, tab.id, true);
    }

    return tab;
  }

  /**
   * 关闭 tab。
   */
  closeTab(threadId: ThreadId, tabId: TabId): TabMetadata | null {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return null;

    // 从 BrowserWindow contentView 移除
    this.window?.contentView.removeChildView(view);

    // 从注册表删除
    this.viewRegistry.delete(threadId, tabId);
    view.webContents.close();
    // 清理 lastBounds
    this.lastBounds.delete(`${threadId}:${tabId}`);

    // Phase 7-1：清理 webContents 反向索引
    this.webContentsIndex.delete(view.webContents.id);

    // Phase 7-3：释放监控 ref + 清理页面洞察缓冲
    this.releaseMonitoring(threadId, tabId);
    this.pageInsightsStore.clearTab(threadId, tabId);

    // 从 tabStore 删除
    const tab = this.tabStore.closeTab(threadId, tabId);

    // 显示新的 active view（如果有）
    const newActiveTabId = this.tabStore.getActiveTab(threadId)?.id;
    if (newActiveTabId) {
      this.showView(threadId, newActiveTabId);
    }

    // incognito session 销毁规则（纯逻辑抽出，见 tab-lifecycle.ts）
    const decision = decideCloseTab(tab?.incognito ?? false, this.tabStore.getTabs(threadId));
    if (decision.destroyIncognitoSession) {
      this.sessionManager.destroyIncognitoPartitions(threadId);
    }

    return tab;
  }

  /**
   * 切换 active tab。
   */
  switchTab(threadId: ThreadId, tabId: TabId): boolean {
    if (!this.tabStore.setActiveTab(threadId, tabId)) return false;
    this.showView(threadId, tabId);
    return true;
  }

  /**
   * 导航操作。
   */
  navigate(threadId: ThreadId, tabId: TabId, action: BrowserNavAction): boolean {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return false;

    const result = validateNavAction(action);
    if (!result.ok || !result.action) return false;

    // 分发逻辑抽到 nav-actions#dispatchNavAction（只依赖 NavTargetLike，可替身测试）
    const outcome = dispatchNavAction(view.webContents as unknown as NavTargetLike, result.action);
    if (!outcome.acted) return false;

    if (outcome.markLoading && outcome.url !== undefined) {
      this.tabStore.updateTab(threadId, tabId, {
        url: outcome.url,
        loadState: "loading",
      });
    }
    return true;
  }

  /**
   * 重新加载 tab。
   */
  reload(threadId: ThreadId, tabId: TabId): boolean {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return false;
    view.webContents.reload();
    return true;
  }

  /**
   * 后退到上一页。
   */
  goBack(threadId: ThreadId, tabId: TabId): boolean {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return false;
    const wc = view.webContents;
    if (!wc.navigationHistory.canGoBack()) return false;
    wc.navigationHistory.goBack();
    return true;
  }

  /**
   * 前进到下一页。
   */
  goForward(threadId: ThreadId, tabId: TabId): boolean {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return false;
    const wc = view.webContents;
    if (!wc.navigationHistory.canGoForward()) return false;
    wc.navigationHistory.goForward();
    return true;
  }

  /**
   * 截图并保存到临时文件（mode 0600，限制仅 owner 可读写）。
   *
   * Phase 7-3：临时文件使用 0600 权限（"加密"实践——限制本机其他用户读取）。
   * 需要成为 Thread Artifact 时通过 uploadArtifact 上传到 Server。
   *
   * Phase 7-6：写入后注册到 tempFileRegistry，使 closeThread / 进程退出能兜底清理
   * 即使上传链路未触发或失败也不会留下孤儿文件。
   *
   * @param format - 'png' 或 'jpeg'
   * @returns 临时文件路径
   */
  async captureScreenshot(threadId: ThreadId, tabId: TabId, format: string): Promise<string> {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) {
      throw new Error(`tab ${tabId} 不存在`);
    }
    const wc = view.webContents;
    const image = await wc.capturePage();
    const ext = format === "jpeg" ? "jpg" : "png";
    const filename = `screenshot-${threadId}-${tabId}-${Date.now()}.${ext}`;
    const filepath = path.join(os.tmpdir(), filename);
    const buffer = format === "jpeg" ? image.toJPEG(80) : image.toPNG();
    // mode 0600：仅 owner 可读写，防止本机其他用户读取截图内容
    await fs.promises.writeFile(filepath, buffer, { mode: 0o600 });
    // Phase 7-6：注册到 registry，由 closeThread / before-quit / 上传成功后清理
    this.tempFileRegistry.register(threadId, filepath, "screenshot");
    return filepath;
  }

  /**
   * Phase 7-6：上传成功后清理本地临时文件。
   *
   * 由 uploadDownload 等上传路径调用——unlink 成功后从 registry 注销条目。
   * unlink 失败（权限不足、文件被占用等）不抛——registry 条目保留以便 closeThread 重试。
   *
   * @returns true 表示文件已不存在（删除或本来就不存在）
   */
  private async cleanupTempFileAfterUpload(filePath: string): Promise<boolean> {
    const ok = await safeUnlink(filePath);
    if (ok) {
      this.tempFileRegistry.unregister(filePath);
    }
    return ok;
  }

  /**
   * 获取指定 tab 的 DebuggerSession 句柄（用于 BrowserCommandTarget）。
   *
   * 返回非 null 表示 tab 存在且可 attach。实际 CDP 交互通过 scheduler 完成。
   */
  getDebuggerSession(threadId: ThreadId, tabId: TabId): unknown {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return null;
    return { scheduler: this.debuggerScheduler, threadId, tabId };
  }

  /**
   * 在指定坐标点击。
   * @param button - 'left' / 'right' / 'middle'，默认 'left'
   */
  async click(
    threadId: ThreadId,
    tabId: TabId,
    x: number,
    y: number,
    button?: string,
  ): Promise<boolean> {
    const validButton = button === "right" || button === "middle" ? button : "left";
    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) return false;
    try {
      const press = await target.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: validButton,
        clickCount: 1,
      });
      if (!press.ok) return false;
      const release = await target.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: validButton,
        clickCount: 1,
      });
      return release.ok;
    } finally {
      this.debuggerScheduler.release(threadId, tabId);
    }
  }

  /**
   * 双击指定坐标（两次连续 click）。
   */
  async doubleClick(threadId: ThreadId, tabId: TabId, x: number, y: number): Promise<boolean> {
    const ok1 = await this.click(threadId, tabId, x, y, "left");
    if (!ok1) return false;
    return this.click(threadId, tabId, x, y, "left");
  }

  /**
   * 输入文本。
   * @param selector - 可选 CSS 选择器，定位焦点元素后再输入
   */
  async type(threadId: ThreadId, tabId: TabId, text: string, selector?: string): Promise<boolean> {
    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) return false;
    try {
      // 如果有 selector，先定位并聚焦元素
      if (selector) {
        const focused = await this.focusElement(target, selector);
        if (!focused) return false;
      }
      const result = await target.sendCommand("Input.insertText", { text });
      return result.ok;
    } finally {
      this.debuggerScheduler.release(threadId, tabId);
    }
  }

  /**
   * 按键。
   * @param key - 键名，如 'Enter'、'Tab'、'Escape'、'a' 等
   */
  async press(threadId: ThreadId, tabId: TabId, key: string): Promise<boolean> {
    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) return false;
    try {
      const cdpKey = toCdpKeyCode(key);
      const down = await target.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: cdpKey.key,
        code: cdpKey.code,
        windowsVirtualKeyCode: cdpKey.keyCode,
      });
      if (!down.ok) return false;
      const up = await target.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: cdpKey.key,
        code: cdpKey.code,
        windowsVirtualKeyCode: cdpKey.keyCode,
      });
      return up.ok;
    } finally {
      this.debuggerScheduler.release(threadId, tabId);
    }
  }

  /**
   * 选择下拉选项。
   * 通过 webContents.executeJavaScript 设置 select 的 value 并触发 change 事件。
   * @param selector - select 元素的 CSS 选择器
   * @param value - 选项的 value（可选，优先于 label）
   * @param label - 选项的文本（可选）
   */
  async select(
    threadId: ThreadId,
    tabId: TabId,
    selector: string,
    value?: string,
    label?: string,
  ): Promise<boolean> {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return false;
    const wc = view.webContents;
    const setByValue = value !== undefined ? `el.value = ${JSON.stringify(value)};` : "";
    const setByLabel =
      label !== undefined
        ? `for (const opt of el.options) { if (opt.text === ${JSON.stringify(label)}) { el.value = opt.value; break; } }`
        : "";
    const script = `(function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.tagName !== 'SELECT') return false;
      ${setByValue}
      ${setByLabel}
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    try {
      const result = await wc.executeJavaScript(script);
      return result === true;
    } catch {
      return false;
    }
  }

  /**
   * 滚动。
   * @param deltaX - 水平滚动量
   * @param deltaY - 垂直滚动量
   */
  async scroll(threadId: ThreadId, tabId: TabId, deltaX: number, deltaY: number): Promise<boolean> {
    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) return false;
    try {
      const result = await target.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 0,
        y: 0,
        deltaX,
        deltaY,
      });
      return result.ok;
    } finally {
      this.debuggerScheduler.release(threadId, tabId);
    }
  }

  /**
   * 上传工作区文件到 file input（Phase 7-2：通过 downloadUrl 下载到临时目录）。
   *
   * 流程：
   * 1. 使用 HTTP GET 下载 downloadUrl 指向的文件到临时目录（os.tmpdir）
   * 2. 将临时文件路径传给 CDP DOM.setFileInputFiles
   * 3. 操作完成后删除临时文件（无论成功/失败）
   *
   * 安全约束：
   * - downloadUrl 由 Server 签发，包含一次性 token，AI 不能伪造
   * - 不接受本机任意路径作为输入，避免 AI 越权读本地文件
   * - 临时文件名使用 UUID，避免与已有文件冲突
   *
   * @param selector - file input 的 CSS 选择器
   * @param downloadUrl - Server 签发的一次性下载凭证 URL
   */
  async uploadWorkspaceFile(
    threadId: ThreadId,
    tabId: TabId,
    selector: string,
    downloadUrl: string,
  ): Promise<boolean> {
    // 1. 下载文件到临时目录
    const tempPath = path.join(os.tmpdir(), `nexharness-upload-${randomUUID()}`);
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok || !response.body) return false;
      // response.body 是 Web ReadableStream，转换为 Node Readable 流式写入临时文件
      const nodeStream = Readable.fromWeb(
        response.body as unknown as import("stream/web").ReadableStream,
      );
      await pipeline(nodeStream, fs.createWriteStream(tempPath));
    } catch {
      // 下载失败时清理已部分写入的临时文件
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // 忽略清理失败
      }
      return false;
    }

    // 2. 通过 CDP 设置 file input
    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // 忽略清理失败
      }
      return false;
    }
    try {
      // 获取 document root（解析规则见 cdp-input#extractDocumentRootId，fail-closed）
      const rootId = extractDocumentRootId(
        await target.sendCommand("DOM.getDocument", { depth: 0 }),
      );
      if (rootId === null) return false;
      // 查询目标元素（nodeId=0 表示未匹配，必须当失败）
      const nodeId = extractQueryNodeId(
        await target.sendCommand("DOM.querySelector", { nodeId: rootId, selector }),
      );
      if (nodeId === null) return false;
      // 设置文件（使用临时文件路径）
      const setResult = await target.sendCommand("DOM.setFileInputFiles", {
        nodeId,
        files: [tempPath],
      });
      return setResult.ok;
    } finally {
      this.debuggerScheduler.release(threadId, tabId);
      // 3. 清理临时文件（无论成功失败都删除，避免临时目录堆积）
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // 忽略清理失败
      }
    }
  }

  /**
   * Phase 7-3：获取页面快照（结构化 DOM 摘要 + 可见文本）。
   *
   * 使用 CDP Runtime.evaluate 在页面上下文中执行脚本，提取：
   * - text: body.innerText（可见文本，截断到 maxTextLength）
   * - domSummary: 结构化 JSON（title、forms、links、meta 信息）
   *
   * 不返回原始 HTML（"DOM 和 accessibility 返回结构化摘要，不向模型默认发送整页 HTML"）
   * @param maxTextLength - 文本截断长度（可选，默认不截断由 redaction 处理）
   */
  async getSnapshot(
    threadId: ThreadId,
    tabId: TabId,
    maxTextLength?: number,
  ): Promise<{ text: string; domSummary: string } | null> {
    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) return null;
    try {
      const expression = `(function() {
        const body = document.body;
        if (!body) return JSON.stringify({ text: '', domSummary: '{}' });
        const text = body.innerText || '';
        const forms = Array.from(document.querySelectorAll('form')).map(f => ({
          action: f.action || '',
          method: f.method || 'get',
          fieldCount: f.elements.length
        }));
        const linkCount = document.querySelectorAll('a[href]').length;
        const formCount = document.querySelectorAll('form').length;
        const inputCount = document.querySelectorAll('input').length;
        const imgCount = document.querySelectorAll('img').length;
        const meta = {
          title: document.title || '',
          url: location.href,
          forms,
          linkCount,
          formCount,
          inputCount,
          imgCount
        };
        return JSON.stringify({ text, domSummary: JSON.stringify(meta) });
      })()`;
      const result = await target.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (!result.ok || !result.result) return null;
      const value = (result.result as { result?: { value?: string } }).result?.value;
      if (typeof value !== "string") return null;
      const parsed = JSON.parse(value) as { text: string; domSummary: string };
      if (maxTextLength && maxTextLength > 0 && parsed.text.length > maxTextLength) {
        parsed.text = `${parsed.text.slice(0, maxTextLength - 3)}...`;
      }
      return parsed;
    } finally {
      this.debuggerScheduler.release(threadId, tabId);
    }
  }

  /**
   * Phase 7-3：获取页面的完整可访问性树。
   *
   * 使用 CDP Accessibility.getFullAXTree 获取结构化 AX 节点。
   */
  async getAccessibilityTree(
    threadId: ThreadId,
    tabId: TabId,
  ): Promise<{ tree: unknown[] } | null> {
    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) return null;
    try {
      const result = await target.sendCommand("Accessibility.getFullAXTree");
      if (!result.ok || !result.result) return null;
      const nodes = (result.result as { nodes?: unknown[] }).nodes ?? [];
      return { tree: nodes };
    } finally {
      this.debuggerScheduler.release(threadId, tabId);
    }
  }

  /**
   * Phase 7-3：获取缓冲的 Console 条目。
   *
   * 首次调用时启用 Runtime+Network 域并持有 debugger ref（持续缓冲事件）。
   * 后续调用直接返回缓冲数据。
   *
   * @param level - "error"（仅 error+pageerror）/ "warning+"（error+pageerror+warning）/ undefined（全部）
   * @param limit - 最大条目数（默认 50）
   */
  async getConsoleEntries(
    threadId: ThreadId,
    tabId: TabId,
    level?: "error" | "warning+",
    limit?: number,
  ): Promise<{ entries: unknown[] } | null> {
    if (!(await this.ensureMonitoring(threadId, tabId))) return null;
    const entries = this.pageInsightsStore.getConsoleEntries(threadId, tabId, level, limit);
    return { entries };
  }

  /**
   * Phase 7-3：获取缓冲的 Network 条目。
   *
   * 首次调用时启用 Runtime+Network 域并持有 debugger ref（持续缓冲事件）。
   * body 始终为 null（body 需通过 Artifact 流程单独获取）。
   *
   * @param filter - "failed"（仅失败）/ "slow"（仅 >1s）/ undefined（全部）
   * @param limit - 最大条目数（默认 50）
   */
  async getNetworkEntries(
    threadId: ThreadId,
    tabId: TabId,
    filter?: "failed" | "slow",
    limit?: number,
  ): Promise<{ entries: unknown[] } | null> {
    if (!(await this.ensureMonitoring(threadId, tabId))) return null;
    const entries = this.pageInsightsStore.getNetworkEntries(threadId, tabId, filter, limit);
    return { entries };
  }

  /**
   * Phase 7-3：确保指定 tab 的 Runtime+Network 监控已启用。
   *
   * 首次调用时：
   * 1. acquire debugger session（attach）
   * 2. 发送 Runtime.enable + Network.enable
   * 3. 注册 CDP 事件处理器（在 setupWebContentsEvents 中已注册）
   * 4. 持有 ref（不 release），保持 debugger 持续 attached 以接收事件
   *
   * 后续调用：直接返回 true（已启用）
   *
   * @returns true 表示监控已启用，false 表示 tab 不存在或 attach 失败
   */
  private async ensureMonitoring(threadId: ThreadId, tabId: TabId): Promise<boolean> {
    const key = `${threadId}:${tabId}`;
    if (this.monitoringRefs.has(key)) return true;

    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) return false;

    // 启用 Runtime 域（捕获 console + exception 事件）
    const runtimeResult = await target.sendCommand("Runtime.enable");
    if (!runtimeResult.ok) {
      this.debuggerScheduler.release(threadId, tabId);
      return false;
    }

    // 启用 Network 域（捕获 request/response/finished/failed 事件）
    const networkResult = await target.sendCommand("Network.enable");
    if (!networkResult.ok) {
      this.debuggerScheduler.release(threadId, tabId);
      return false;
    }

    // 持有 ref（不 release），保持 debugger 持续 attached
    // ref 在 closeTab/closeThread 时释放
    this.monitoringRefs.add(key);
    return true;
  }

  /**
   * Phase 7-3：释放指定 tab 的监控 ref。
   *
   * 在 closeTab 时调用，释放 ensureMonitoring 持有的 debugger ref。
   */
  private releaseMonitoring(threadId: ThreadId, tabId: TabId): void {
    const key = `${threadId}:${tabId}`;
    if (this.monitoringRefs.has(key)) {
      this.monitoringRefs.delete(key);
      this.debuggerScheduler.release(threadId, tabId);
    }
  }

  /**
   * Phase 7-3：处理 CDP 事件，路由到 PageInsightsStore。
   *
   * 在 setupWebContentsEvents 中注册为 wc.debugger.on('message') handler。
   * 仅在 debugger attached 时触发（handler 始终注册但 dormant）。
   */
  private handleCdpEvent(threadId: ThreadId, tabId: TabId, method: string, params: unknown): void {
    const insight = normalizeCdpEvent(method, params);
    if (insight.type === "ignore") return;

    if (insight.type === "console") {
      this.pageInsightsStore.addConsoleEntry(threadId, tabId, insight.insight.entry);
      return;
    }

    const net = insight.insight;
    switch (net.kind) {
      case "request":
        this.pageInsightsStore.bufferNetworkRequest(threadId, tabId, net.requestId, net.params);
        break;
      case "response":
        this.pageInsightsStore.bufferNetworkResponse(threadId, tabId, net.requestId, net.params);
        break;
      case "finished":
        this.pageInsightsStore.finalizeNetworkEntry(threadId, tabId, net.requestId, net.params);
        break;
      case "failed":
        this.pageInsightsStore.failNetworkEntry(threadId, tabId, net.requestId, net.params);
        break;
    }
  }

  /**
   * 内部：通过 selector 定位并聚焦元素。
   * @returns true 表示成功聚焦
   */
  private async focusElement(target: DebuggerSessionTarget, selector: string): Promise<boolean> {
    const docResult = await target.sendCommand("DOM.getDocument", { depth: 0 });
    if (!docResult.ok || !docResult.result) return false;
    const root = (docResult.result as { root?: { nodeId?: number } }).root;
    const rootId = root?.nodeId;
    if (rootId === undefined || rootId === 0) return false;
    const queryResult = await target.sendCommand("DOM.querySelector", {
      nodeId: rootId,
      selector,
    });
    if (!queryResult.ok || !queryResult.result) return false;
    const nodeId = (queryResult.result as { nodeId?: number }).nodeId;
    if (nodeId === undefined || nodeId === 0) return false;
    const focusResult = await target.sendCommand("DOM.focus", { nodeId });
    return focusResult.ok;
  }

  /**
   * 设置 view 的 bounds。
   * @param threadId - Thread ID
   * @param tabId - Tab ID
   * @param bounds - 新 bounds
   * @param scaleFactor - 屏幕缩放因子
   */
  setBounds(threadId: ThreadId, tabId: TabId, bounds: unknown, scaleFactor: number): boolean {
    const view = this.viewRegistry.get(threadId, tabId);
    if (!view) return false;

    const result = validateBounds(bounds, this.config.windowConstraints, scaleFactor);
    if (!result.ok || !result.bounds) return false;

    // 减少不必要的 setBounds 调用
    const key = `${threadId}:${tabId}`;
    const last = this.lastBounds.get(key);
    if (last && !boundsChanged(last, result.bounds)) {
      return true;
    }

    view.setBounds(result.bounds);
    this.lastBounds.set(key, result.bounds);
    return true;
  }

  /**
   * 隐藏 Thread 的所有 views（切到非 Browser tab / 最小化时调用）。
   */
  hideThreadViews(threadId: ThreadId): void {
    const viewIds = this.viewRegistry.getViewIds(threadId);
    for (const tabId of viewIds) {
      const view = this.viewRegistry.get(threadId, tabId);
      if (view) {
        view.setBounds(hiddenBounds());
        this.lastBounds.delete(`${threadId}:${tabId}`);
      }
    }
  }

  /**
   * 显示 Thread 的 active view。
   */
  showActiveView(threadId: ThreadId): void {
    const activeTabId = this.viewRegistry.getActiveTabId(threadId);
    if (activeTabId) {
      this.showView(threadId, activeTabId);
    }
  }

  /**
   * 关闭 Thread 的所有 tabs 并清理该 Thread 的本地资源。
   *
   * Phase 7-6：清理该 Thread 的所有本地临时文件（screenshot + 待上传 download）。
   * 注意 cleanupThreadTempFiles 是异步的，但 closeThread 本身同步返回——
   * 文件清理在后台执行，不阻塞 closeThread 完成信号。失败仅记录不抛。
   */
  closeThread(threadId: ThreadId): number {
    // 从 contentView 移除所有 view 并清理 lastBounds + webContents 反向索引
    const viewIds = this.viewRegistry.getViewIds(threadId);
    for (const tabId of viewIds) {
      const view = this.viewRegistry.get(threadId, tabId);
      if (view) {
        this.window?.contentView.removeChildView(view);
        this.webContentsIndex.delete(view.webContents.id);
        view.webContents.close();
      }
      this.lastBounds.delete(`${threadId}:${tabId}`);
    }

    // 清空注册表（WebContentsView 由 GC 回收， contentView 移除后不再渲染）
    this.viewRegistry.clearThread(threadId);

    // 清理该 Thread 的所有 DebuggerSession（强制 detach）
    this.debuggerScheduler.clearThread(threadId);

    // Phase 7-3：释放该 Thread 所有 tab 的监控 ref
    for (const tabId of viewIds) {
      this.releaseMonitoring(threadId, tabId);
    }
    // 清理该 Thread 的所有页面洞察缓冲
    this.pageInsightsStore.clearThread(threadId);

    // 销毁 incognito partitions
    this.sessionManager.destroyIncognitoPartitions(threadId);

    // Phase 7-1：清理该 Thread 的下载记录
    this.downloadManager?.clearThread(threadId);

    // Phase 7-6：清理该 Thread 的所有本地临时文件（fire-and-forget）
    // 不 await——closeThread 同步返回，文件清理在后台执行
    void cleanupThreadTempFiles(this.tempFileRegistry, threadId);

    // Phase 8：联动清理隐藏 QA WebContents 和临时 session partition
    this.qaController?.closeThread(threadId);

    // 关闭所有 tabs，并删除该 Thread 的持久化恢复记录。
    const count = this.tabStore.closeAllTabs(threadId);
    this.config.tabRestore?.deleteThread(threadId);
    return count;
  }

  /**
   * Phase 7-6：清理所有 Thread 的本地临时文件（用于进程退出兜底）。
   *
   * 由 app.on("before-quit") 调用——尽量在退出前清理所有未跟踪的孤儿文件。
   * 不抛错——清理失败仅静默忽略，进程仍正常退出。
   */
  async cleanupAllTempFiles(): Promise<number> {
    return cleanupAllTempFiles(this.tempFileRegistry);
  }

  /** 退出前将所有持久 Browser Profile 的 Cookie/storage 明确刷盘。 */
  async flushPersistentStorage(): Promise<void> {
    const partitions = this.sessionManager
      .getUserIds()
      .map((userId) => this.sessionManager.getOrCreateBrowserPartition(userId));
    await Promise.all(
      partitions.map((partition) => session.fromPartition(partition).flushStorageData()),
    );
  }

  /** 获取 tab 元数据列表 */
  getTabs(threadId: ThreadId): TabMetadata[] {
    return this.tabStore.getTabs(threadId);
  }

  /** 重排 tab，并通过 TabStore 订阅链同步持久化。 */
  reorderTabs(threadId: ThreadId, tabIds: TabId[]): boolean {
    return this.tabStore.reorderTabs(threadId, tabIds);
  }

  /** 获取 active tab */
  getActiveTab(threadId: ThreadId): TabMetadata | null {
    return this.tabStore.getActiveTab(threadId);
  }

  /** 获取所有 Thread ID */
  getThreadIds(): ThreadId[] {
    return this.tabStore.getThreadIds();
  }

  /**
   * Phase 8：获取 SessionManager 实例（供 logout 流程枚举已注册 userId）。
   *
   * SessionManager 维护 userId → partition 的内存映射，
   * logout 时遍历所有 userId 清理对应的 Browser Profile 持久化数据。
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  isUserInputBlocked(threadId: ThreadId): boolean {
    return this.inputBlockedThreads.has(threadId);
  }

  async setUserInputBlocked(threadId: ThreadId, blocked: boolean): Promise<void> {
    if (blocked) this.inputBlockedThreads.add(threadId);
    else this.inputBlockedThreads.delete(threadId);
    await Promise.all(
      this.viewRegistry
        .getViewIds(threadId)
        .map((tabId) => this.setTabInputBlocked(threadId, tabId, blocked)),
    );
  }

  private async setTabInputBlocked(
    threadId: ThreadId,
    tabId: TabId,
    blocked: boolean,
  ): Promise<void> {
    const target = await this.debuggerScheduler.acquire(threadId, tabId);
    if (!target) return;
    try {
      await target.sendCommand("Input.setIgnoreInputEvents", { ignore: blocked });
    } finally {
      this.debuggerScheduler.release(threadId, tabId);
    }
  }

  /**
   * 订阅指定 Thread 的 tab 变更事件。
   * 当 tab 创建/关闭/更新/切换时回调。
   * @returns 取消订阅函数
   */
  subscribe(
    threadId: ThreadId,
    callback: (tabs: TabMetadata[], activeTab: TabMetadata | null) => void,
  ): () => void {
    return this.tabStore.subscribe((event) => {
      const eventThreadId = "tab" in event ? event.tab.threadId : event.threadId;
      if (eventThreadId !== threadId) return;
      callback(this.tabStore.getTabs(threadId), this.tabStore.getActiveTab(threadId));
    });
  }

  /** 内部：显示指定 view，隐藏其他 */
  private showView(threadId: ThreadId, tabId: TabId): void {
    const change = this.viewRegistry.getActivationChange(threadId, tabId);
    if (!change) return;

    // 设置 active
    this.viewRegistry.setActive(threadId, tabId);

    // 隐藏旧 active view
    if (change.hide) {
      change.hide.setBounds(hiddenBounds());
    }

    // 显示新 active view
    if (change.show) {
      const key = `${threadId}:${tabId}`;
      const last = this.lastBounds.get(key);
      const bounds = last ?? DEFAULT_VISIBLE_BOUNDS;
      change.show.setBounds(bounds);
    }
  }

  /** 内部：设置 WebContents 事件监听 */
  private setupWebContentsEvents(threadId: ThreadId, tabId: TabId, view: WebContentsView): void {
    // 事件接线（导航/标题/权限/弹窗/证书/导航拦截/CDP）委托给 web-contents-wiring，
    // 使这部分可单测（传 WebContents 替身）且不占用 controller 篇幅。
    registerWebContentsHandlers(view.webContents as unknown as WebContentsLike, {
      updateTab: (patch) => this.tabStore.updateTab(threadId, tabId, patch),
      indexWebContents: (webContentsId) =>
        this.webContentsIndex.set(webContentsId, { threadId, tabId }),
      setupDownloadHandler: (session) => this.setupDownloadHandler(session as Session),
      handleCdpEvent: (method, params) => this.handleCdpEvent(threadId, tabId, method, params),
    });
  }

  private setupDownloadHandler(session: Session): void {
    if (this.registeredDownloadSessions.has(session)) return;
    this.registeredDownloadSessions.add(session);

    session.on("will-download", (_event, item, webContents) => {
      if (!this.downloadManager) return;
      // 下载生命周期（记录/进度/终态/上传/清理）委托给 DownloadCoordinator。
      // 依赖注入使协调器可用 fake 依赖单测（Electron 对象无法在 vitest 实例化）。
      handleWillDownload(this.downloadDeps(), item, webContents.id);
    });
  }

  /** 组装下载协调器依赖（把 this 的能力映射为协调器所需的最小接口）。 */
  private downloadDeps(): DownloadCoordinatorDeps {
    return {
      downloadManager: this.downloadManager as DownloadManagerLike,
      getUploadConfig: () => this.downloadUploadConfig,
      resolveTab: (webContentsId) => this.webContentsIndex.get(webContentsId) ?? null,
      registerTempFile: (threadId, path, kind) =>
        this.tempFileRegistry.register(threadId, path, kind),
      uploadFile: (params) => uploadFileToWorkspace(params),
      cleanupFile: (path) => this.cleanupTempFileAfterUpload(path),
    };
  }
}
