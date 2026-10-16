import { describe, expect, it, vi } from "vitest";
import {
  type DownloadCoordinatorDeps,
  type DownloadItemLike,
  type DownloadManagerLike,
  cleanupCancelled,
  handleWillDownload,
  uploadDownload,
} from "./download-coordinator";

/**
 * 下载协调器把 Electron will-download 生命周期接到 DownloadManager + 上传。
 * 用 fake 依赖测试（Electron 对象无法在 vitest 实例化）。
 * 这些用例锁定：归属反查、终态分支、fire-and-forget 上传、终态一律清理。
 */
function fakeManager(): DownloadManagerLike & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    createDownload: vi.fn((input) => {
      calls.push(`create:${input.fileName}`);
      return { id: "dl-1" };
    }),
    updateProgress: vi.fn((id, bytes) => calls.push(`progress:${bytes}`)),
    completeDownload: vi.fn((id, p) => calls.push(`complete:${p}`)),
    cancelDownload: vi.fn(() => calls.push("cancel")),
    failDownload: vi.fn((id, r) => calls.push(`fail:${r}`)),
    startUpload: vi.fn(() => calls.push("startUpload")),
    completeUpload: vi.fn((id, wp) => calls.push(`uploaded:${wp}`)),
    failUpload: vi.fn((id, e) => calls.push(`uploadFailed:${e}`)),
  };
}

function fakeItem(over: Partial<DownloadItemLike> = {}): DownloadItemLike & {
  fire: (event: "updated" | "done", state: string) => void;
} {
  const handlers: Record<string, ((e: unknown, s: string) => void)[]> = {};
  const base = {
    getFilename: () => "report.pdf",
    getURLChain: () => ["https://x/y"],
    getMimeType: () => "application/pdf",
    getTotalBytes: () => 100,
    getReceivedBytes: () => 40,
    getSavePath: () => "/tmp/report.pdf",
    on(event: string, listener: (e: unknown, s: string) => void) {
      const list = handlers[event] ?? [];
      list.push(listener);
      handlers[event] = list;
    },
    fire(event: string, state: string) {
      for (const h of handlers[event] ?? []) h({}, state);
    },
    ...over,
  };
  return base as never;
}

function fakeDeps(over: Partial<DownloadCoordinatorDeps> = {}): DownloadCoordinatorDeps & {
  manager: ReturnType<typeof fakeManager>;
  cleanupCalls: string[];
  registered: string[];
} {
  const manager = fakeManager();
  const cleanupCalls: string[] = [];
  const registered: string[] = [];
  return {
    manager,
    cleanupCalls,
    registered,
    downloadManager: manager,
    getUploadConfig: () => ({ serverOrigin: "https://srv" }),
    resolveTab: () => ({ threadId: "t1", tabId: "tab1" }),
    registerTempFile: (_t, p) => registered.push(p),
    uploadFile: async () => ({ ok: true, workspacePath: "downloads/report.pdf" }),
    cleanupFile: async (p) => {
      cleanupCalls.push(p);
      return true;
    },
    ...over,
  };
}

describe("handleWillDownload — 归属与记录", () => {
  it("未知 webContents → 忽略（不创建记录）", () => {
    const deps = fakeDeps({ resolveTab: () => null });
    expect(handleWillDownload(deps, fakeItem(), 999)).toBeNull();
    expect(deps.manager.createDownload).not.toHaveBeenCalled();
  });

  it("已知归属 → 创建记录并从 URLChain 取首个 URL", () => {
    const deps = fakeDeps();
    const id = handleWillDownload(deps, fakeItem(), 1);
    expect(id).toBe("dl-1");
    expect(deps.manager.createDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "t1",
        tabId: "tab1",
        fileName: "report.pdf",
        url: "https://x/y",
      }),
    );
  });

  it("URLChain 为空 → url 为空串（不崩）", () => {
    const deps = fakeDeps();
    handleWillDownload(deps, fakeItem({ getURLChain: () => [] }), 1);
    expect(deps.manager.createDownload).toHaveBeenCalledWith(expect.objectContaining({ url: "" }));
  });

  it("progressing 事件更新进度；其它状态不更新", () => {
    const deps = fakeDeps();
    const item = fakeItem();
    handleWillDownload(deps, item, 1);
    item.fire("updated", "progressing");
    expect(deps.manager.updateProgress).toHaveBeenCalledWith("dl-1", 40);
    item.fire("updated", "interrupted");
    expect(deps.manager.updateProgress).toHaveBeenCalledTimes(1);
  });
});

describe("handleWillDownload — 终态分支", () => {
  it("completed → completeDownload + 注册临时文件 + 触发上传", async () => {
    const deps = fakeDeps();
    const item = fakeItem();
    handleWillDownload(deps, item, 1);
    item.fire("done", "completed");
    expect(deps.manager.completeDownload).toHaveBeenCalledWith("dl-1", "/tmp/report.pdf");
    expect(deps.registered).toEqual(["/tmp/report.pdf"]);
    await vi.waitFor(() => expect(deps.manager.completeUpload).toHaveBeenCalled());
  });

  it("cancelled → cancelDownload + 清理部分写入文件", async () => {
    const deps = fakeDeps();
    const item = fakeItem();
    handleWillDownload(deps, item, 1);
    item.fire("done", "cancelled");
    expect(deps.manager.cancelDownload).toHaveBeenCalledWith("dl-1");
    await vi.waitFor(() => expect(deps.cleanupCalls).toContain("/tmp/report.pdf"));
  });

  it("interrupted → failDownload + 清理", async () => {
    const deps = fakeDeps();
    const item = fakeItem();
    handleWillDownload(deps, item, 1);
    item.fire("done", "interrupted");
    expect(deps.manager.failDownload).toHaveBeenCalledWith("dl-1", "下载interrupted");
    await vi.waitFor(() => expect(deps.cleanupCalls).toContain("/tmp/report.pdf"));
  });

  it("无上传配置时 completed 不上传（仅记记录）", () => {
    const deps = fakeDeps({ getUploadConfig: () => null });
    const item = fakeItem();
    handleWillDownload(deps, item, 1);
    item.fire("done", "completed");
    expect(deps.manager.startUpload).not.toHaveBeenCalled();
  });
});

describe("uploadDownload — 不伪装成功 + 终态清理", () => {
  it("上传成功 → completeUpload 并清理本机文件", async () => {
    const deps = fakeDeps();
    await uploadDownload(deps, "dl-1", "t1", "/tmp/report.pdf", "report.pdf");
    expect(deps.manager.startUpload).toHaveBeenCalledWith("dl-1");
    expect(deps.manager.completeUpload).toHaveBeenCalledWith("dl-1", "downloads/report.pdf");
    expect(deps.cleanupCalls).toEqual(["/tmp/report.pdf"]);
  });

  it("上传失败 → failUpload（不伪装成功）且**也**清理本机文件", async () => {
    const deps = fakeDeps({
      uploadFile: async () => ({ ok: false, workspacePath: null, error: "HTTP 502" }),
    });
    await uploadDownload(deps, "dl-1", "t1", "/tmp/report.pdf", "report.pdf");
    expect(deps.manager.failUpload).toHaveBeenCalledWith("dl-1", "HTTP 502");
    expect(deps.manager.completeUpload).not.toHaveBeenCalled();
    expect(deps.cleanupCalls).toEqual(["/tmp/report.pdf"]);
  });

  it("ok 但 workspacePath 为 null → 视为失败", async () => {
    const deps = fakeDeps({
      uploadFile: async () => ({ ok: true, workspacePath: null }),
    });
    await uploadDownload(deps, "dl-1", "t1", "/tmp/x", "x");
    expect(deps.manager.failUpload).toHaveBeenCalled();
    expect(deps.manager.completeUpload).not.toHaveBeenCalled();
  });

  it("无上传配置 → 直接返回（不 startUpload）", async () => {
    const deps = fakeDeps({ getUploadConfig: () => null });
    await uploadDownload(deps, "dl-1", "t1", "/tmp/x", "x");
    expect(deps.manager.startUpload).not.toHaveBeenCalled();
  });
});

describe("cleanupCancelled", () => {
  it("委托给 cleanupFile（幂等语义由实现保证）", async () => {
    const deps = fakeDeps();
    expect(await cleanupCancelled(deps, "/tmp/partial")).toBe(true);
    expect(deps.cleanupCalls).toEqual(["/tmp/partial"]);
  });
});
