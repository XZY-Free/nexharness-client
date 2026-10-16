import { describe, expect, it, vi } from "vitest";
import {
  type TabStatePatch,
  type WebContentsLike,
  type WebContentsWiringDeps,
  registerWebContentsHandlers,
} from "./web-contents-wiring";

/**
 * WebContents 事件接线：把 Electron 事件桥接到纯策略函数 + 状态回调。
 * 用替身测试（无需真实 Electron），覆盖各事件分支与安全默认。
 * 端到端行为另由 e2e/browser-controller.electron.cjs 在真实 Electron 中验证。
 */
function fakeWebContents(over: Partial<WebContentsLike> = {}) {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  let windowOpenHandler: ((d: { url: string }) => { action: "deny" }) | null = null;
  let permissionHandler:
    | ((wc: { getURL(): string }, p: string, cb: (g: boolean) => void) => void)
    | null = null;
  const debuggerHandlers = new Map<string, (...args: unknown[]) => void>();

  const session = {
    setPermissionRequestHandler: (
      h: (wc: { getURL(): string }, p: string, cb: (g: boolean) => void) => void,
    ) => {
      permissionHandler = h;
    },
  };

  const wc = {
    id: 42,
    session,
    getURL: () => "https://nex.example.com/page",
    getTitle: () => "标题",
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    on(event: string, listener: (...args: unknown[]) => void) {
      const prev = handlers.get(event) ?? (() => {});
      handlers.set(event, (...a: unknown[]) => {
        prev(...a);
        listener(...a);
      });
    },
    setWindowOpenHandler(h: (d: { url: string }) => { action: "deny" }) {
      windowOpenHandler = h;
    },
    debugger: {
      on(event: string, h: (...args: unknown[]) => void) {
        debuggerHandlers.set(event, h);
      },
    },
    ...over,
  };

  return {
    wc: wc as unknown as WebContentsLike,
    emit: (event: string, ...args: unknown[]) => handlers.get(event)?.(...args),
    callWindowOpen: (url: string) => windowOpenHandler?.({ url }),
    callPermission: (permission: string) => {
      let granted: boolean | null = null;
      permissionHandler?.({ getURL: () => wc.getURL() }, permission, (g) => {
        granted = g;
      });
      return granted;
    },
    emitDebugger: (method: string, params: unknown) =>
      debuggerHandlers.get("message")?.({}, method, params),
  };
}

function fakeDeps() {
  const patches: TabStatePatch[] = [];
  const indexed: number[] = [];
  const sessions: unknown[] = [];
  const cdp: Array<{ method: string; params: unknown }> = [];
  const deps: WebContentsWiringDeps = {
    updateTab: (p) => patches.push(p),
    indexWebContents: (id) => indexed.push(id),
    setupDownloadHandler: (s) => sessions.push(s),
    handleCdpEvent: (method, params) => cdp.push({ method, params }),
  };
  return { deps, patches, indexed, sessions, cdp };
}

describe("registerWebContentsHandlers — 接线与索引", () => {
  it("注册时建立 webContents 反向索引 + 注册下载处理器", () => {
    const { wc } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    expect(d.indexed).toEqual([42]);
    expect(d.sessions.length).toBe(1);
  });
});

describe("registerWebContentsHandlers — 导航状态", () => {
  it("did-start-loading → loadState=loading", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    emit("did-start-loading");
    expect(d.patches).toEqual([{ loadState: "loading" }]);
  });

  it("did-stop-loading → loaded + url/title/canGoBack/canGoForward", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    emit("did-stop-loading");
    expect(d.patches).toEqual([
      {
        loadState: "loaded",
        url: "https://nex.example.com/page",
        title: "标题",
        canGoBack: true,
        canGoForward: false,
      },
    ]);
  });

  it("title / favicon 更新", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    emit("page-title-updated", {}, "新标题");
    emit("page-favicon-updated", {}, ["https://x/f.ico"]);
    expect(d.patches).toEqual([{ title: "新标题" }, { favicon: "https://x/f.ico" }]);
  });

  it("favicon 空数组 → null（不写 undefined）", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    emit("page-favicon-updated", {}, []);
    expect(d.patches).toEqual([{ favicon: null }]);
  });

  it("render-process-gone → crashed + 原因", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    emit("render-process-gone", {}, { reason: "oom" });
    expect(d.patches).toEqual([{ loadState: "crashed", error: "oom" }]);
  });

  it("render-process-gone 无 reason → 兜底文案", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    emit("render-process-gone", {}, {});
    expect(d.patches[0]?.error).toBe("render process crashed");
  });
});

describe("registerWebContentsHandlers — 安全默认（fail-closed）", () => {
  it("弹窗一律 deny（含受信任 origin）", () => {
    const { wc, callWindowOpen } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    expect(callWindowOpen("https://nex.example.com/x")).toEqual({ action: "deny" });
    expect(callWindowOpen("https://evil.com/x")).toEqual({ action: "deny" });
  });

  it("证书错误默认不 trust", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    let trust: boolean | null = null;
    emit("certificate-error", {}, "https://x", "CERT_AUTHORITY_INVALID", {}, (t: boolean) => {
      trust = t;
    });
    expect(trust).toBe(false);
  });

  it("will-navigate 对 blocked URL 调 preventDefault", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    let prevented = false;
    emit(
      "will-navigate",
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      "javascript:alert(1)",
    );
    expect(prevented).toBe(true);
  });

  it("will-navigate 对安全 URL 不 preventDefault", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    let prevented = false;
    emit(
      "will-navigate",
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      "https://nex.example.com/a",
    );
    expect(prevented).toBe(false);
  });

  it("will-frame-navigate 同样拦截 blocked URL（覆盖子 frame）", () => {
    const { wc, emit } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    let prevented = false;
    emit("will-frame-navigate", {
      url: "javascript:alert(1)",
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });

  it("权限请求经 decidePermission 决定（未知权限默认拒绝）", () => {
    const { wc, callPermission } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    expect(callPermission("unknown-permission")).toBe(false);
  });
});

describe("registerWebContentsHandlers — CDP 路由", () => {
  it("debugger message → 交给 handleCdpEvent（归一化在内部完成，此处不重复）", () => {
    const { wc, emitDebugger } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    emitDebugger("Runtime.consoleAPICalled", { args: [] });
    expect(d.cdp).toEqual([{ method: "Runtime.consoleAPICalled", params: { args: [] } }]);
  });

  it("未知 CDP 方法也路由（由 handleCdpEvent 自行 ignore）", () => {
    const { wc, emitDebugger } = fakeWebContents();
    const d = fakeDeps();
    registerWebContentsHandlers(wc, d.deps);
    emitDebugger("Unknown.method", {});
    expect(d.cdp.length).toBe(1);
  });
});
