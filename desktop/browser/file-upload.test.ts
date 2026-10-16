import { describe, expect, it, vi } from "vitest";
import {
  type FileUploadDeps,
  type UploadTargetLike,
  downloadUrlToFileImpl,
  uploadWorkspaceFileWith,
} from "./file-upload";

/**
 * 上传编排。**清理契约**是重点：无论成功/失败（下载失败 / acquire 失败 / CDP 失败 /
 * 定位失败）都必须删临时文件，否则临时目录堆积。
 */
function fakeDeps(over: Partial<FileUploadDeps> = {}) {
  const log: string[] = [];
  const deps: FileUploadDeps = {
    makeTempPath: () => {
      log.push("makeTempPath");
      return "/tmp/nexharness-upload-uuid";
    },
    downloadToFile: async () => {
      log.push("download");
      return true;
    },
    acquire: async () => {
      log.push("acquire");
      return targetOk(true, true, true);
    },
    release: () => log.push("release"),
    unlink: async () => {
      log.push("unlink");
    },
    extractRootId: () => {
      log.push("extractRootId");
      return 1;
    },
    extractNodeId: () => {
      log.push("extractNodeId");
      return 2;
    },
    ...over,
  };
  return { deps, log };
}

function targetOk(...results: boolean[]): UploadTargetLike {
  let i = 0;
  return {
    sendCommand: vi.fn(async () => ({ ok: results[i++] ?? true, result: {} })),
  };
}

describe("uploadWorkspaceFileWith — 正常路径", () => {
  it("成功：下载 → acquire → getDocument → querySelector → setFileInputFiles → release + 清理", async () => {
    const { deps, log } = fakeDeps();
    expect(await uploadWorkspaceFileWith("#file", "https://srv/dl", deps)).toBe(true);
    expect(log).toEqual([
      "makeTempPath",
      "download",
      "acquire",
      "extractRootId",
      "extractNodeId",
      "release",
      "unlink",
    ]);
  });

  it("setFileInputFiles 的 files 参数是临时路径", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const t: UploadTargetLike = {
      sendCommand: async (method, params) => {
        calls.push({ method, params });
        return { ok: true, result: {} };
      },
    };
    const { deps } = fakeDeps({ acquire: async () => t });
    await uploadWorkspaceFileWith("#file", "https://srv/dl", deps);
    const setCall = calls.find((c) => c.method === "DOM.setFileInputFiles");
    expect((setCall?.params as { files: string[] }).files).toEqual(["/tmp/nexharness-upload-uuid"]);
  });

  it("selector 传给 DOM.querySelector", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const t: UploadTargetLike = {
      sendCommand: async (method, params) => {
        calls.push({ method, params });
        return { ok: true, result: {} };
      },
    };
    const { deps } = fakeDeps({ acquire: async () => t });
    await uploadWorkspaceFileWith("input[type=file]", "https://srv/dl", deps);
    const q = calls.find((c) => c.method === "DOM.querySelector");
    expect((q?.params as { selector: string }).selector).toBe("input[type=file]");
  });
});

describe("uploadWorkspaceFileWith — 清理契约（临时文件不堆积）", () => {
  it("下载失败 → 清理并 false（不 acquire）", async () => {
    const { deps, log } = fakeDeps({
      downloadToFile: async () => {
        log.push("download");
        return false;
      },
    });
    expect(await uploadWorkspaceFileWith("#f", "u", deps)).toBe(false);
    expect(log).toContain("unlink");
    expect(log).not.toContain("acquire");
  });

  it("acquire 失败 → 清理并 false", async () => {
    const { deps, log } = fakeDeps({
      acquire: async () => {
        log.push("acquire");
        return null;
      },
    });
    expect(await uploadWorkspaceFileWith("#f", "u", deps)).toBe(false);
    expect(log).toContain("unlink");
    expect(log).not.toContain("release");
  });

  it("rootId 解析失败 → 仍 release + cleanup", async () => {
    const { deps, log } = fakeDeps({ extractRootId: () => null });
    expect(await uploadWorkspaceFileWith("#f", "u", deps)).toBe(false);
    expect(log).toContain("release");
    expect(log).toContain("unlink");
  });

  it("nodeId 解析失败（如 CDP nodeId=0）→ 仍 release + cleanup", async () => {
    const { deps, log } = fakeDeps({ extractNodeId: () => null });
    expect(await uploadWorkspaceFileWith("#f", "u", deps)).toBe(false);
    expect(log).toContain("release");
    expect(log).toContain("unlink");
  });

  it("setFileInputFiles 返回 !ok → release + cleanup 且 false", async () => {
    const { deps, log } = fakeDeps({ acquire: async () => targetOk(true, true, false) });
    expect(await uploadWorkspaceFileWith("#f", "u", deps)).toBe(false);
    expect(log).toContain("unlink");
    expect(log).toContain("release");
  });

  it("**所有分支都清理**（枚举 4 种失败，均含 unlink）", async () => {
    const cases: Partial<FileUploadDeps>[] = [
      { downloadToFile: async () => false },
      { acquire: async () => null },
      { extractRootId: () => null },
      { extractNodeId: () => null },
    ];
    for (const c of cases) {
      const { deps, log } = fakeDeps(c);
      await uploadWorkspaceFileWith("#f", "u", deps);
      expect(log, `分支未清理：${JSON.stringify(Object.keys(c))}`).toContain("unlink");
    }
  });
});

describe("downloadUrlToFileImpl", () => {
  /** 最小可读流替身：支持 on('data') 与 destroy（字节上限检测用）。 */
  function readableStub() {
    const listeners: Array<(chunk: unknown) => void> = [];
    return {
      on(event: string, listener: (chunk: unknown) => void) {
        if (event === "data") listeners.push(listener);
      },
      destroy() {},
      emitData(chunk: unknown) {
        for (const l of listeners) l(chunk);
      },
    } as unknown as NodeJS.ReadableStream;
  }

  function deps(over = {}) {
    return {
      url: "https://srv/dl",
      dest: "/tmp/x",
      createWriteStream: () => ({}) as NodeJS.WritableStream,
      fromWeb: () => readableStub(),
      pipeline: async () => {},
      ...over,
    };
  }

  it("成功：200 + body → pipeline 写入 → true", async () => {
    const pipeline = vi.fn(async () => {});
    const fetcher = vi.fn(
      async () => new Response("data", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await downloadUrlToFileImpl(deps({ pipeline, fetcher }))).toBe(true);
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("非 2xx → false（不 pipeline）", async () => {
    const pipeline = vi.fn(async () => {});
    const fetcher = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await downloadUrlToFileImpl(deps({ pipeline, fetcher }))).toBe(false);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("无 body → false", async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    // Response(null).body 为 null
    expect(await downloadUrlToFileImpl(deps({ fetcher }))).toBe(false);
  });

  it("fetch 抛错 → false（不抛）", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await downloadUrlToFileImpl(deps({ fetcher }))).toBe(false);
  });

  it("pipeline 抛错 → false", async () => {
    const fetcher = vi.fn(
      async () => new Response("data", { status: 200 }),
    ) as unknown as typeof fetch;
    const pipeline = vi.fn(async () => {
      throw new Error("EPIPE");
    });
    expect(await downloadUrlToFileImpl(deps({ pipeline, fetcher }))).toBe(false);
  });
});

/**
 * 下载加固（安全关键）：host 白名单 + 字节上限。
 * downloadUrl 由 Server 签发，但远端主机与响应体大小不受本端控制。
 */
describe("downloadUrlToFileImpl — host 白名单与字节上限（安全关键）", () => {
  /** 最小可读流替身（实现会监听 data 做字节计数）。 */
  function streamStub() {
    return { on() {}, destroy() {} } as unknown as NodeJS.ReadableStream;
  }

  const okFetcher = vi.fn(
    async () => new Response("data", { status: 200 }),
  ) as unknown as typeof fetch;

  function base(over = {}) {
    return {
      url: "https://srv/dl",
      dest: "/tmp/x",
      createWriteStream: () => ({}) as NodeJS.WritableStream,
      fromWeb: () => streamStub(),
      pipeline: async () => {},
      fetcher: okFetcher,
      ...over,
    };
  }

  it("allowedOrigins 命中 → 放行", async () => {
    expect(await downloadUrlToFileImpl(base({ allowedOrigins: ["https://srv"] }))).toBe(true);
  });

  it("allowedOrigins 未命中 → false 且不发请求", async () => {
    const fetcher = vi.fn(
      async () => new Response("x", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(
      await downloadUrlToFileImpl(base({ fetcher, allowedOrigins: ["https://other.example"] })),
    ).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("非 http(s) 协议即使 origin 匹配也拒绝", async () => {
    expect(await downloadUrlToFileImpl(base({ allowedOrigins: ["file://"] }))).toBe(false);
  });

  it("不传 allowedOrigins → 不做 host 约束（向后兼容）", async () => {
    expect(await downloadUrlToFileImpl(base())).toBe(true);
  });

  it("content-length 声明超限 → false 且不 pipeline", async () => {
    const pipeline = vi.fn(async () => {});
    const fetcher = vi.fn(
      async () => new Response("x", { status: 200, headers: { "content-length": "9999" } }),
    ) as unknown as typeof fetch;
    expect(await downloadUrlToFileImpl(base({ fetcher, pipeline, maxBytes: 100 }))).toBe(false);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("流式累计超限 → 中断并返回 false", async () => {
    const stream = {
      listeners: [] as Array<(c: unknown) => void>,
      on(event: string, l: (c: unknown) => void) {
        if (event === "data") this.listeners.push(l);
      },
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
      emit(c: unknown) {
        for (const l of this.listeners) l(c);
      },
    };
    const fetcher = vi.fn(
      async () => new Response("x", { status: 200 }),
    ) as unknown as typeof fetch;
    const pipeline = vi.fn(async () => {
      // 模拟 stream 在写入过程中吐数据
      stream.emit(Buffer.alloc(500));
    });
    const result = await downloadUrlToFileImpl(
      base({ fetcher, pipeline, maxBytes: 100, fromWeb: () => stream as never }),
    );
    expect(result).toBe(false);
    expect(stream.destroyed).toBe(true);
  });
});

describe("isDownloadUrlAllowed — host 白名单纯函数", () => {
  it("空白名单 / 未传 → 不约束", async () => {
    const { isDownloadUrlAllowed } = await import("./file-upload");
    expect(isDownloadUrlAllowed("https://x/a", [])).toBe(true);
    expect(isDownloadUrlAllowed("https://x/a", undefined)).toBe(true);
  });

  it("未命中 → false；非法 URL → false", async () => {
    const { isDownloadUrlAllowed } = await import("./file-upload");
    expect(isDownloadUrlAllowed("https://x/a", ["https://y"])).toBe(false);
    expect(isDownloadUrlAllowed("not-a-url", ["https://x"])).toBe(false);
  });

  it("按 origin 比对（忽略 path / query）", async () => {
    const { isDownloadUrlAllowed } = await import("./file-upload");
    expect(isDownloadUrlAllowed("https://x/a?b=1", ["https://x/base"])).toBe(true);
  });

  it("协议不同即不等价（同 host 的 http vs https）", async () => {
    const { isDownloadUrlAllowed } = await import("./file-upload");
    expect(isDownloadUrlAllowed("http://x/a", ["https://x"])).toBe(false);
  });
});
