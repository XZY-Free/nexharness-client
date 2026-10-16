import { describe, expect, it } from "vitest";
import {
  SCREENSHOT_FILE_MODE,
  normalizeScreenshotFormat,
  sanitizeFileToken,
  screenshotExtension,
  screenshotFilePath,
} from "./screenshot";

/**
 * 截图落盘规则。**是安全相关**：截图可能含敏感页面内容，
 * 必须以 0600（仅 owner）写入，且格式归一不得出现"未知格式当 png"以外的宽松分支。
 */
describe("SCREENSHOT_FILE_MODE — 文件权限（安全关键）", () => {
  it("必须是 0600（仅 owner 可读写）", () => {
    expect(SCREENSHOT_FILE_MODE).toBe(0o600);
  });

  it("不高于 0600（防 group/other 可读）", () => {
    expect(SCREENSHOT_FILE_MODE & 0o077).toBe(0);
  });
});

describe("normalizeScreenshotFormat", () => {
  it("精确 jpeg → jpeg", () => {
    expect(normalizeScreenshotFormat("jpeg")).toBe("jpeg");
  });

  it("png → png", () => {
    expect(normalizeScreenshotFormat("png")).toBe("png");
  });

  it("未知/大小写不符/空 → 回落 png（安全默认，不接受 jpg/webp 等别名）", () => {
    for (const f of ["jpg", "JPEG", "webp", "", "gif", "png "]) {
      expect(normalizeScreenshotFormat(f)).toBe("png");
    }
  });
});

describe("screenshotExtension", () => {
  it("jpeg → jpg（扩展名映射）", () => {
    expect(screenshotExtension("jpeg")).toBe("jpg");
  });

  it("其余 → png", () => {
    expect(screenshotExtension("png")).toBe("png");
    expect(screenshotExtension("whatever")).toBe("png");
  });
});

describe("screenshotFilePath", () => {
  it("包含 threadId / tabId / 时间戳 / 正确扩展名", () => {
    const p = screenshotFilePath({
      threadId: "t1",
      tabId: "tab2",
      format: "png",
      now: 1700000000000,
      tmpDir: "/tmp",
    });
    expect(p).toBe("/tmp/screenshot-t1-tab2-1700000000000.png");
  });

  it("jpeg → .jpg 后缀", () => {
    const p = screenshotFilePath({
      threadId: "t",
      tabId: "x",
      format: "jpeg",
      now: 1,
      tmpDir: "/tmp",
    });
    expect(p.endsWith(".jpg")).toBe(true);
  });

  it("不同 tabId 生成不同路径（不互相覆盖）", () => {
    const base = { threadId: "t", format: "png", now: 1, tmpDir: "/tmp" };
    expect(screenshotFilePath({ ...base, tabId: "a" })).not.toBe(
      screenshotFilePath({ ...base, tabId: "b" }),
    );
  });

  it("不同时间戳生成不同路径", () => {
    const base = { threadId: "t", tabId: "x", format: "png", tmpDir: "/tmp" };
    expect(screenshotFilePath({ ...base, now: 1 })).not.toBe(
      screenshotFilePath({ ...base, now: 2 }),
    );
  });

  it("未指定 tmpDir → 落在系统临时目录", () => {
    const p = screenshotFilePath({ threadId: "t", tabId: "x", format: "png", now: 1 });
    expect(p.startsWith("/")).toBe(true);
    expect(p).toContain("screenshot-t-x-1.png");
  });
});

/**
 * 路径穿越防护。threadId / tabId 来自 RPC 信封，schema 只约束「非空字符串」——
 * 若含 `/`、`\` 或 `..`，path.join 会逃出临时目录写到任意路径。**安全关键**。
 */
describe("sanitizeFileToken — 标识符净化（安全关键）", () => {
  it("保留合法字符 [A-Za-z0-9_-]", () => {
    expect(sanitizeFileToken("Abc-123_x")).toBe("Abc-123_x");
  });

  it("斜杠 / 反斜杠 / 点 等替换为下划线", () => {
    // 点号也一并净化（比只删分隔符更严），因此 ".." 变成 "__"
    expect(sanitizeFileToken("../../etc/passwd")).toBe("______etc_passwd");
    expect(sanitizeFileToken("a\\b")).toBe("a_b");
    expect(sanitizeFileToken("a/b")).toBe("a_b");
    expect(sanitizeFileToken("..")).toBe("__");
  });

  it("净化后不含任何路径分隔符", () => {
    for (const evil of ["../x", "..\\x", "/abs", "a/b/c", "~/$HOME"]) {
      const safe = sanitizeFileToken(evil);
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("\\");
    }
  });
});

describe("screenshotFilePath — 不可逃出 tmpDir（安全关键）", () => {
  it("含 ../ 的 threadId 无法穿越出 tmpDir", () => {
    const p = screenshotFilePath({
      threadId: "../../../../etc/cron.d/evil",
      tabId: "x",
      format: "png",
      now: 1,
      tmpDir: "/tmp",
    });
    expect(p.startsWith("/tmp/")).toBe(true);
    // 净化后文件名内不再有分隔符 → 目录层级不会增加
    expect(p.split("/").length).toBe(3);
  });

  it("含 / 的 tabId 同样被限制在 tmpDir 内", () => {
    const p = screenshotFilePath({
      threadId: "t",
      tabId: "a/b",
      format: "png",
      now: 1,
      tmpDir: "/tmp",
    });
    expect(p).toBe("/tmp/screenshot-t-a_b-1.png");
  });
});
