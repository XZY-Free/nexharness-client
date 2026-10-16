import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_ORIGIN,
  getOrigin,
  isTrustedServerOrigin,
  loadAllowedOrigins,
  shouldBlockNavigation,
} from "./origin-guard";

/**
 * origin 守卫是桌面端防导航劫持的安全边界（BrowserWindow 内只允许受信任 origin）。
 * 这些用例锁定「谁能进、谁被拦」，任何放宽都必须先改测试。
 */
describe("getOrigin", () => {
  it("http/https 返回 origin", () => {
    expect(getOrigin("https://nex.example.com/nexharness?a=1")).toBe("https://nex.example.com");
    expect(getOrigin("http://localhost:3000/x")).toBe("http://localhost:3000");
  });

  it("about:blank 返回哨兵值", () => {
    expect(getOrigin("about:blank")).toBe("about:blank");
  });

  it("非 http(s) 协议与空值返回 null", () => {
    expect(getOrigin("file:///etc/passwd")).toBeNull();
    expect(getOrigin("data:text/html,<h1>x</h1>")).toBeNull();
    expect(getOrigin("blob:https://x/y")).toBeNull();
    expect(getOrigin("")).toBeNull();
    expect(getOrigin("not a url")).toBeNull();
  });
});

describe("isTrustedServerOrigin", () => {
  const allowed = ["https://nex.example.com", "http://localhost:3000"];

  it("精确匹配受信任 origin 放行", () => {
    expect(isTrustedServerOrigin("https://nex.example.com/app", allowed)).toBe(true);
    expect(isTrustedServerOrigin("http://localhost:3000/chat", allowed)).toBe(true);
  });

  it("允许列表条目可含 basePath，比对时提取纯 origin", () => {
    expect(
      isTrustedServerOrigin("https://nex.example.com/x", ["https://nex.example.com/nexharness"]),
    ).toBe(true);
  });

  it("未列入的 origin 一律拒绝", () => {
    expect(isTrustedServerOrigin("https://evil.example.com/", allowed)).toBe(false);
    expect(isTrustedServerOrigin("http://localhost:9999/", allowed)).toBe(false);
  });

  it("生产不允许非 localhost 的 http（除非显式 opt-in）", () => {
    const insecure = ["http://internal.corp:8080"];
    expect(isTrustedServerOrigin("http://internal.corp:8080/x", insecure)).toBe(false);
    expect(isTrustedServerOrigin("http://internal.corp:8080/x", insecure, true)).toBe(true);
  });

  it("about:blank 不是 server origin", () => {
    expect(isTrustedServerOrigin("about:blank", allowed)).toBe(false);
  });
});

describe("shouldBlockNavigation", () => {
  const allowed = ["https://nex.example.com"];

  it("受信任 origin 与 about:blank 不拦", () => {
    expect(shouldBlockNavigation("https://nex.example.com/a", allowed)).toBe(false);
    expect(shouldBlockNavigation("about:blank", allowed)).toBe(false);
  });

  it("外部 origin、非 http(s) 协议、空值、非法 URL 一律拦", () => {
    expect(shouldBlockNavigation("https://evil.com", allowed)).toBe(true);
    expect(shouldBlockNavigation("file:///etc/passwd", allowed)).toBe(true);
    expect(shouldBlockNavigation("data:text/html,x", allowed)).toBe(true);
    expect(shouldBlockNavigation("", allowed)).toBe(true);
    expect(shouldBlockNavigation("ht!tp://bad", allowed)).toBe(true);
  });
});

describe("loadAllowedOrigins", () => {
  it("未配置回退默认值", () => {
    expect(loadAllowedOrigins({})).toEqual([DEFAULT_SERVER_ORIGIN]);
    expect(loadAllowedOrigins({ NEX_SERVER_ORIGIN: "   " })).toEqual([DEFAULT_SERVER_ORIGIN]);
  });

  it("逗号分隔并去除空白", () => {
    expect(loadAllowedOrigins({ NEX_SERVER_ORIGIN: "https://a.com, https://b.com " })).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });
});
