import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadFileToWorkspace } from "./download-uploader";

/**
 * uploadFileToWorkspace 把本机下载文件流式推送到 Server workspace。
 * 这些用例锁定：本地校验、请求契约（octet-stream + X-File-Name）、
 * **响应解析（apiSuccess 裸对象 {path}）**、各失败分支。
 */
const mocks = vi.hoisted(() => ({
  statSync: vi.fn(),
  createReadStream: vi.fn(),
}));

vi.mock("node:fs", () => ({
  statSync: mocks.statSync,
  createReadStream: mocks.createReadStream,
}));

/** 造一个假的 ReadStream（可被 fetch 当 body，且触发 data 事件）。 */
function fakeStream(chunks: Buffer[] = []) {
  const handlers: Record<string, ((arg: unknown) => void)[]> = {};
  const stream = {
    on(event: string, cb: (arg: unknown) => void) {
      const list = handlers[event] ?? [];
      list.push(cb);
      handlers[event] = list;
      return stream;
    },
    emit(event: string, arg?: unknown) {
      for (const cb of handlers[event] ?? []) cb(arg);
    },
    chunks,
  };
  return stream;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const CONFIG = { serverOrigin: "https://nex.example.com", authToken: "tok-1" };

beforeEach(() => {
  mocks.statSync.mockReset();
  mocks.createReadStream.mockReset();
  // 默认：文件存在、10 字节
  mocks.statSync.mockReturnValue({ isFile: () => true, size: 10 });
  mocks.createReadStream.mockReturnValue(fakeStream([Buffer.from("0123456789")]));
});

describe("uploadFileToWorkspace — 本地校验", () => {
  it("文件不存在 → 不发起请求", async () => {
    mocks.statSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/x",
      fileName: "x.bin",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("无法读取文件");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("路径不是文件（目录）→ 拒绝", async () => {
    mocks.statSync.mockReturnValue({ isFile: () => false, size: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/dir",
      fileName: "d",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("路径不是文件");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("uploadFileToWorkspace — 请求契约", () => {
  it("POST 到 /workspace/upload，带 octet-stream + X-File-Name + Bearer", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ path: "downloads/a.bin" }));
    await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/a.bin",
      fileName: "a b.bin",
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://nex.example.com/api/threads/t1/workspace/upload");
    expect(init.method).toBe("POST");
    const h = init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/octet-stream");
    expect(h["x-file-name"]).toBe(encodeURIComponent("a b.bin"));
    expect(h.authorization).toBe("Bearer tok-1");
    fetchSpy.mockRestore();
  });

  it("threadId 被 URL 编码（防注入路径）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ path: "p" }));
    await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t/../admin",
      filePath: "/tmp/a",
      fileName: "a",
    });
    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain(encodeURIComponent("t/../admin"));
    expect(url).not.toContain("/admin/workspace");
    fetchSpy.mockRestore();
  });

  it("无 authToken 时不带 Authorization 头", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ path: "p" }));
    await uploadFileToWorkspace({
      config: { serverOrigin: "https://x" },
      threadId: "t1",
      filePath: "/tmp/a",
      fileName: "a",
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    fetchSpy.mockRestore();
  });
});

describe("uploadFileToWorkspace — 响应解析（apiSuccess 裸对象）", () => {
  it("裸对象 { path } → ok:true 且 workspacePath=path", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ path: "downloads/report.pdf", name: "report.pdf", size: 1234 }),
    );
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/r.pdf",
      fileName: "report.pdf",
    });
    expect(r.ok).toBe(true);
    expect(r.workspacePath).toBe("downloads/report.pdf");
    vi.restoreAllMocks();
  });

  it("旧 { ok:true, data:{...} } 信封不再被接受（服务端已统一 apiSuccess）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ok: true, data: { workspacePath: "downloads/x" } }),
    );
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/x",
      fileName: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("path");
    vi.restoreAllMocks();
  });

  it("缺 path 字段 → 失败（不伪装成功）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ name: "x" }));
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/x",
      fileName: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.workspacePath).toBeNull();
    vi.restoreAllMocks();
  });

  it("path 非字符串 → 失败", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ path: 123 }));
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/x",
      fileName: "x",
    });
    expect(r.ok).toBe(false);
    vi.restoreAllMocks();
  });

  it("响应非 JSON → 失败", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { status: 200 }));
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/x",
      fileName: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("响应解析失败");
    vi.restoreAllMocks();
  });
});

describe("uploadFileToWorkspace — 失败分支", () => {
  it("HTTP 非 2xx → 失败且带状态码", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 404));
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/x",
      fileName: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("404");
    vi.restoreAllMocks();
  });

  it("网络异常 → 失败（不抛出）", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/x",
      fileName: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("上传请求失败");
    vi.restoreAllMocks();
  });

  it("进度回调按 chunk 累计", async () => {
    const stream = fakeStream();
    mocks.createReadStream.mockReturnValue(stream);
    mocks.statSync.mockReturnValue({ isFile: () => true, size: 20 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      stream.emit("data", Buffer.alloc(12));
      stream.emit("data", Buffer.alloc(8));
      return jsonResponse({ path: "p" });
    });
    const seen: number[] = [];
    await uploadFileToWorkspace({
      config: CONFIG,
      threadId: "t1",
      filePath: "/tmp/x",
      fileName: "x",
      onProgress: (uploaded, total) => {
        expect(total).toBe(20);
        seen.push(uploaded);
      },
    });
    expect(seen).toEqual([12, 20]);
    vi.restoreAllMocks();
  });
});
