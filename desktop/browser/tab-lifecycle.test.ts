import { describe, expect, it } from "vitest";
import {
  type DownloadCleanupReason,
  decideCloseTab,
  decideUploadOutcome,
  shouldCleanupLocalFile,
} from "./tab-lifecycle";

/**
 * Tab 生命周期规则是「关闭 tab / 上传完成 / 清理文件」的判定核心。
 * 这些用例锁定：incognito session 销毁时机、上传不伪装成功、终态一律清理。
 */
function tab(incognito: boolean) {
  return { incognito };
}

describe("decideCloseTab — incognito session 销毁时机", () => {
  it("关闭最后一个 incognito tab → 销毁 session", () => {
    expect(decideCloseTab(true, [])).toEqual({ destroyIncognitoSession: true });
    expect(decideCloseTab(true, [tab(false), tab(false)])).toEqual({
      destroyIncognitoSession: true,
    });
  });

  it("还有其它 incognito tab → 保留 session", () => {
    expect(decideCloseTab(true, [tab(false), tab(true)])).toEqual({
      destroyIncognitoSession: false,
    });
  });

  it("关闭非 incognito tab → 不影响 session（即便没有 incognito 残留）", () => {
    expect(decideCloseTab(false, [])).toEqual({ destroyIncognitoSession: false });
    expect(decideCloseTab(false, [tab(true)])).toEqual({ destroyIncognitoSession: false });
  });

  it("tab 不存在（incognito=false）→ 不销毁", () => {
    expect(decideCloseTab(false, [tab(true)])).toEqual({ destroyIncognitoSession: false });
  });
});

describe("decideUploadOutcome — 不伪装成功", () => {
  it("ok 且有 workspacePath → uploaded", () => {
    expect(decideUploadOutcome({ ok: true, workspacePath: "downloads/a.zip" })).toEqual({
      state: "uploaded",
      workspacePath: "downloads/a.zip",
    });
  });

  it("ok 但 workspacePath 为 null → upload_failed（不伪装成功）", () => {
    const out = decideUploadOutcome({ ok: true, workspacePath: null });
    expect(out.state).toBe("upload_failed");
  });

  it("ok=false → upload_failed 且带错误信息", () => {
    expect(decideUploadOutcome({ ok: false, workspacePath: null, error: "HTTP 500" })).toEqual({
      state: "upload_failed",
      error: "HTTP 500",
    });
  });

  it("ok=false 且无 error → 兜底文案", () => {
    expect(decideUploadOutcome({ ok: false, workspacePath: null })).toEqual({
      state: "upload_failed",
      error: "上传失败",
    });
  });

  it("空字符串 workspacePath 视为失败（不算成功）", () => {
    expect(decideUploadOutcome({ ok: true, workspacePath: "" }).state).toBe("upload_failed");
  });
});

describe("shouldCleanupLocalFile — 终态一律清理", () => {
  it("四种终态都需清理（防孤儿文件）", () => {
    for (const reason of [
      "uploaded",
      "upload_failed",
      "cancelled",
      "interrupted",
    ] as DownloadCleanupReason[]) {
      expect(shouldCleanupLocalFile(reason)).toBe(true);
    }
  });

  it("upload_failed 也清理（fire-and-forget 不重试，保留只会成孤儿）", () => {
    expect(shouldCleanupLocalFile("upload_failed")).toBe(true);
  });
});
