import { describe, expect, it, vi } from "vitest";
import { SECURE_WEB_PREFERENCES, createSecureView, resolvePartitionKey } from "./view-factory";

/**
 * WebContentsView 的安全参数是**攻击面**。这些用例把"必须保持最严"固化为断言：
 * 任何放宽（如 nodeIntegration: true）都会立刻让测试失败，而不是悄悄上线。
 */
describe("SECURE_WEB_PREFERENCES — 安全基线", () => {
  it("sandbox 必须开启", () => {
    expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true);
  });

  it("contextIsolation 必须开启", () => {
    expect(SECURE_WEB_PREFERENCES.contextIsolation).toBe(true);
  });

  it("nodeIntegration 必须关闭（否则页面可读写任意文件）", () => {
    expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false);
  });

  it("webSecurity 必须开启（保持同源策略）", () => {
    expect(SECURE_WEB_PREFERENCES.webSecurity).toBe(true);
  });

  it("allowRunningInsecureContent 必须关闭", () => {
    expect(SECURE_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
  });

  it("不含任何额外/未知键（防止有人偷偷加开放项）", () => {
    expect(Object.keys(SECURE_WEB_PREFERENCES).sort()).toEqual(
      [
        "allowRunningInsecureContent",
        "contextIsolation",
        "nodeIntegration",
        "sandbox",
        "webSecurity",
      ].sort(),
    );
  });
});

describe("createSecureView", () => {
  it("把全部安全参数与 partition 一起传给构造器", () => {
    const Ctor = vi.fn(function (this: unknown, opts: unknown) {
      return opts;
    }) as unknown as new (
      o: unknown,
    ) => unknown;
    const view = createSecureView(Ctor as never, { partition: "persist:u1" });
    expect(Ctor).toHaveBeenCalledWith({
      webPreferences: { partition: "persist:u1", ...SECURE_WEB_PREFERENCES },
    });
    expect((view as { webPreferences: Record<string, unknown> }).webPreferences.sandbox).toBe(true);
  });

  it("安全参数无法被调用方覆盖（接口只接受 partition）", () => {
    // 注意：替身必须是 function（可 new），箭头函数不可构造
    const Ctor = vi.fn(function (this: unknown, _opts: unknown) {
      return { webPreferences: SECURE_WEB_PREFERENCES };
    }) as unknown as new (
      o: unknown,
    ) => unknown;
    createSecureView(Ctor as never, { partition: "persist:u1" });
    const arg = (Ctor as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      webPreferences: Record<string, unknown>;
    };
    expect(arg.webPreferences.nodeIntegration).toBe(false);
    expect(arg.webPreferences.sandbox).toBe(true);
  });
});

describe("resolvePartitionKey — Thread 隔离", () => {
  it("有 userId → 用 userId", () => {
    expect(resolvePartitionKey({ userId: "u1", threadId: "t1" })).toBe("u1");
  });

  it("userId 为空串 / undefined → **回退 threadId**（保证不同 Thread 不共用 partition）", () => {
    expect(resolvePartitionKey({ userId: "", threadId: "t1" })).toBe("t1");
    expect(resolvePartitionKey({ threadId: "t1" })).toBe("t1");
  });

  it("不同 threadId 得到不同 key（不串 cookie）", () => {
    const a = resolvePartitionKey({ threadId: "thread-A" });
    const b = resolvePartitionKey({ threadId: "thread-B" });
    expect(a).not.toBe(b);
  });
});
