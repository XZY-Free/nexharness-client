import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_CAPABILITY_VERSION,
  DESKTOP_IPC_CHANNELS,
  getDesktopCapabilities,
  isAllowedOrigin,
  isDesktop,
  isValidDesktopCapabilities,
} from "./capabilities";

/**
 * capabilities 是 renderer 注入值的信任边界 —— 校验不严会让页面拿到伪造的桥接口。
 * 这些用例锁定：origin 协议白名单、IPC channel 白名单、版本匹配。
 */
function caps(over: Record<string, unknown> = {}) {
  return {
    version: DESKTOP_CAPABILITY_VERSION,
    serverOrigin: "https://nex.example.com",
    appVersion: "1.0.0",
    ipcChannels: ["desktop:getCapabilities"],
    deviceId: null,
    ...over,
  };
}

describe("isAllowedOrigin", () => {
  it("https 一律允许", () => {
    expect(isAllowedOrigin("https://nex.example.com")).toBe(true);
    expect(isAllowedOrigin("https://any.domain/path")).toBe(true);
  });

  it("localhost / 127.0.0.1 的 http 允许", () => {
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8080")).toBe(true);
  });

  it("公网 http 默认拒绝，显式 opt-in 才放行", () => {
    expect(isAllowedOrigin("http://remote.example.com")).toBe(false);
    expect(isAllowedOrigin("http://remote.example.com", true)).toBe(true);
  });

  it("非 http(s) 协议与非法 URL 拒绝", () => {
    for (const o of ["file:///etc/passwd", "ftp://x", "javascript:alert(1)", "not a url", ""]) {
      expect(isAllowedOrigin(o)).toBe(false);
    }
  });
});

describe("isValidDesktopCapabilities", () => {
  it("合法 capabilities 通过", () => {
    expect(isValidDesktopCapabilities(caps())).toBe(true);
  });

  it("版本不匹配拒绝", () => {
    expect(isValidDesktopCapabilities(caps({ version: 999 }))).toBe(false);
  });

  it("非对象 / null 拒绝", () => {
    expect(isValidDesktopCapabilities(null)).toBe(false);
    expect(isValidDesktopCapabilities("x")).toBe(false);
    expect(isValidDesktopCapabilities(undefined)).toBe(false);
  });

  it("serverOrigin 非法协议拒绝", () => {
    expect(isValidDesktopCapabilities(caps({ serverOrigin: "file:///x" }))).toBe(false);
    expect(isValidDesktopCapabilities(caps({ serverOrigin: "http://remote.com" }))).toBe(false);
    // 带 allowInsecureRemoteOrigin 时放行公网 http
    expect(
      isValidDesktopCapabilities(
        caps({ serverOrigin: "http://remote.com", allowInsecureRemoteOrigin: true }),
      ),
    ).toBe(true);
  });

  it("appVersion 空 / 非字符串拒绝", () => {
    expect(isValidDesktopCapabilities(caps({ appVersion: "" }))).toBe(false);
    expect(isValidDesktopCapabilities(caps({ appVersion: 1 }))).toBe(false);
  });

  it("ipcChannels 非数组拒绝", () => {
    expect(isValidDesktopCapabilities(caps({ ipcChannels: "x" }))).toBe(false);
  });

  it("ipcChannels 含白名单外 channel 拒绝（防注入任意 IPC）", () => {
    expect(isValidDesktopCapabilities(caps({ ipcChannels: ["desktop:evilShellExecution"] }))).toBe(
      false,
    );
    expect(
      isValidDesktopCapabilities(caps({ ipcChannels: ["desktop:getCapabilities", "hack:system"] })),
    ).toBe(false);
  });

  it("ipcChannels 全部在白名单内则可接受（含多项）", () => {
    expect(isValidDesktopCapabilities(caps({ ipcChannels: [...DESKTOP_IPC_CHANNELS] }))).toBe(true);
  });

  it("deviceId 允许 null 或字符串，其它类型拒绝", () => {
    expect(isValidDesktopCapabilities(caps({ deviceId: null }))).toBe(true);
    expect(isValidDesktopCapabilities(caps({ deviceId: "dev-1" }))).toBe(true);
    expect(isValidDesktopCapabilities(caps({ deviceId: 123 }))).toBe(false);
  });
});

describe("getDesktopCapabilities / isDesktop", () => {
  afterEach(() => {
    (globalThis as { nexDesktop?: unknown }).nexDesktop = undefined;
  });

  it("无桥接时返回 null，isDesktop 为 false", () => {
    expect(getDesktopCapabilities()).toBeNull();
    expect(isDesktop()).toBe(false);
  });

  it("桥接 capabilities 合法时返回，isDesktop 为 true", () => {
    (globalThis as { nexDesktop?: unknown }).nexDesktop = { capabilities: caps() };
    expect(getDesktopCapabilities()).not.toBeNull();
    expect(isDesktop()).toBe(true);
  });

  it("桥接 capabilities 非法时返回 null（不信任伪造值）", () => {
    (globalThis as { nexDesktop?: unknown }).nexDesktop = {
      capabilities: caps({ serverOrigin: "http://evil.com" }),
    };
    expect(getDesktopCapabilities()).toBeNull();
    expect(isDesktop()).toBe(false);
  });
});
