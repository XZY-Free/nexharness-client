import { describe, expect, it, vi } from "vitest";
import type { TabMetadata } from "../browser/tab-store";
import {
  type BrowserActionTarget,
  type BrowserCommandTarget,
  executeActionCommand,
  executeReadCommand,
} from "./command-executor";

/**
 * 命令执行器把 Server RPC 分发到浏览器能力桩（可注入 mock）。
 * 这些用例锁定：缺字段拒绝、未知命令拒绝、读取类返回形状、操作类透传成功/失败。
 */
function tab(over: Partial<TabMetadata> = {}): TabMetadata {
  return {
    id: "tab1",
    threadId: "t1",
    url: "https://x/a",
    title: "A",
    favicon: null,
    loadState: "idle",
    canGoBack: false,
    canGoForward: false,
    incognito: false,
    createdAt: 1,
    updatedAt: 1,
    error: null,
    ...over,
  };
}

function readTarget(over: Partial<BrowserCommandTarget> = {}): BrowserCommandTarget {
  return {
    getTabs: () => [tab()],
    getActiveTab: () => tab(),
    ...over,
  };
}

function actionTarget(over: Partial<BrowserActionTarget> = {}): BrowserActionTarget {
  return {
    navigate: vi.fn(() => true),
    closeTab: vi.fn(() => true),
    switchTab: vi.fn(() => true),
    createTab: vi.fn(() => tab()),
    reload: vi.fn(() => true),
    goBack: vi.fn(() => true),
    goForward: vi.fn(() => true),
    click: vi.fn(async () => true),
    doubleClick: vi.fn(async () => true),
    type: vi.fn(async () => true),
    press: vi.fn(async () => true),
    select: vi.fn(async () => true),
    scroll: vi.fn(async () => true),
    uploadWorkspaceFile: vi.fn(async () => true),
    ...over,
  } as unknown as BrowserActionTarget;
}

describe("executeReadCommand", () => {
  it("getTabs 返回 tabs + activeTabId", async () => {
    const r = await executeReadCommand({
      target: readTarget(),
      command: "browser.getTabs",
      payload: {},
      threadId: "t1",
    });
    expect(r.ok).toBe(true);
    expect((r.result as { activeTabId: string }).activeTabId).toBe("tab1");
  });

  it("active tab 为 null 时 activeTabId 为 null", async () => {
    const r = await executeReadCommand({
      target: readTarget({ getActiveTab: () => null }),
      command: "browser.getTabs",
      payload: {},
      threadId: "t1",
    });
    expect((r.result as { activeTabId: unknown }).activeTabId).toBeNull();
  });

  it("getPageMetadata 缺 tabId → rpc_invalid_payload", async () => {
    const r = await executeReadCommand({
      target: readTarget(),
      command: "browser.getPageMetadata",
      payload: {},
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("rpc_invalid_payload");
  });

  it("getPageMetadata 目标 tab 不存在 → tab_not_found", async () => {
    const r = await executeReadCommand({
      target: readTarget(),
      command: "browser.getPageMetadata",
      payload: { tabId: "ghost" },
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("tab_not_found");
  });

  it("getPageMetadata 返回 tab 元数据字段", async () => {
    const r = await executeReadCommand({
      target: readTarget(),
      command: "browser.getPageMetadata",
      payload: { tabId: "tab1" },
      threadId: "t1",
    });
    expect(r.ok).toBe(true);
    expect((r.result as { url: string }).url).toBe("https://x/a");
  });

  it("screenshot 目标不支持时 browser_internal", async () => {
    const r = await executeReadCommand({
      target: readTarget(), // 无 captureScreenshot
      command: "browser.screenshot",
      payload: { tabId: "tab1" },
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("browser_internal");
  });

  it("screenshot 成功返回 path", async () => {
    const r = await executeReadCommand({
      target: readTarget({ captureScreenshot: async () => "/tmp/s.png" }),
      command: "browser.screenshot",
      payload: { tabId: "tab1" },
      threadId: "t1",
    });
    expect(r.ok).toBe(true);
    expect((r.result as { path: string }).path).toBe("/tmp/s.png");
  });

  it("screenshot 抛错时捕获为 browser_internal（不冒泡）", async () => {
    const r = await executeReadCommand({
      target: readTarget({
        captureScreenshot: async () => {
          throw new Error("boom");
        },
      }),
      command: "browser.screenshot",
      payload: { tabId: "tab1" },
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("boom");
  });

  it("未知读取命令 → unknown_command", async () => {
    const r = await executeReadCommand({
      target: readTarget(),
      command: "browser.hack",
      payload: {},
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unknown_command");
  });
});

describe("executeActionCommand", () => {
  it("navigate 透传 tabId+url", async () => {
    const navigate = vi.fn(() => true);
    const r = await executeActionCommand({
      target: actionTarget({ navigate }),
      command: "browser.navigate",
      payload: { tabId: "tab1", url: "https://x" },
      threadId: "t1",
    });
    expect(r.ok).toBe(true);
    expect(navigate).toHaveBeenCalledWith("t1", "tab1", "https://x");
  });

  it("navigate 缺 url → rpc_invalid_payload，不调用 target", async () => {
    const navigate = vi.fn(() => true);
    const r = await executeActionCommand({
      target: actionTarget({ navigate }),
      command: "browser.navigate",
      payload: { tabId: "tab1" },
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("rpc_invalid_payload");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("click 缺 x/y → 拒绝；默认 button 为 left", async () => {
    const click = vi.fn(async () => true);
    const bad = await executeActionCommand({
      target: actionTarget({ click }),
      command: "browser.click",
      payload: { tabId: "tab1", x: 1 },
      threadId: "t1",
    });
    expect(bad.ok).toBe(false);

    await executeActionCommand({
      target: actionTarget({ click }),
      command: "browser.click",
      payload: { tabId: "tab1", x: 1, y: 2 },
      threadId: "t1",
    });
    expect(click).toHaveBeenCalledWith("t1", "tab1", 1, 2, "left");
  });

  it("target 返回 false → browser_internal", async () => {
    const r = await executeActionCommand({
      target: actionTarget({ navigate: () => false }),
      command: "browser.navigate",
      payload: { tabId: "tab1", url: "https://x" },
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("browser_internal");
  });

  it("type 缺 text 拒绝；空字符串 text 视为缺（extractString 拒绝空串）", async () => {
    const type = vi.fn(async () => true);
    const r = await executeActionCommand({
      target: actionTarget({ type }),
      command: "browser.type",
      payload: { tabId: "tab1", text: "" },
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(type).not.toHaveBeenCalled();
  });

  it("press 缺 key 拒绝", async () => {
    const r = await executeActionCommand({
      target: actionTarget(),
      command: "browser.press",
      payload: { tabId: "tab1" },
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("rpc_invalid_payload");
  });

  it("非字符串 / 非有限数参数视为缺失（拒绝注入）", async () => {
    const r = await executeActionCommand({
      target: actionTarget(),
      command: "browser.click",
      payload: { tabId: "tab1", x: "1", y: Number.NaN },
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("rpc_invalid_payload");
  });

  it("未知操作命令 → unknown_command", async () => {
    const r = await executeActionCommand({
      target: actionTarget(),
      command: "browser.evil",
      payload: {},
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("unknown_command");
  });

  it("payload 为 null/undefined 不抛错（按缺字段处理）", async () => {
    const r = await executeActionCommand({
      target: actionTarget(),
      command: "browser.navigate",
      payload: null,
      threadId: "t1",
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe("rpc_invalid_payload");
  });

  it("scroll 透传 deltaX/deltaY", async () => {
    const scroll = vi.fn(async () => true);
    await executeActionCommand({
      target: actionTarget({ scroll }),
      command: "browser.scroll",
      payload: { tabId: "tab1", deltaX: 0, deltaY: 100 },
      threadId: "t1",
    });
    expect(scroll).toHaveBeenCalledWith("t1", "tab1", 0, 100);
  });
});
