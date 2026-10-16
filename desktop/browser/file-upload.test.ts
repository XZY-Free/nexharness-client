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
  function deps(over = {}) {
    return {
      url: "https://srv/dl",
      dest: "/tmp/x",
      createWriteStream: () => ({}) as NodeJS.WritableStream,
      fromWeb: () => ({}) as NodeJS.ReadableStream,
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
