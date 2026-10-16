import { describe, expect, it } from "vitest";
import { MAX_URL_LENGTH, isValidNavUrl, normalizeUrl, validateNavAction } from "./nav-actions";

/**
 * 导航校验是「AI/用户能命令浏览器去哪」的信任边界。
 * 这些用例锁定：只允许 http/https、危险协议一律拒、超长 URL 拒。
 */
describe("isValidNavUrl", () => {
  it("http/https 合法", () => {
    expect(isValidNavUrl("http://x/a")).toBe(true);
    expect(isValidNavUrl("https://x/a?b=1#c")).toBe(true);
  });

  it("危险协议拒绝（file/data/blob/javascript/ftp）", () => {
    for (const u of [
      "file:///etc/passwd",
      "data:text/html,x",
      "blob:https://x/y",
      "javascript:alert(1)",
      "ftp://x/f",
      "about:blank",
    ]) {
      expect(isValidNavUrl(u)).toBe(false);
    }
  });

  it("非字符串 / 空串 / 非法 URL 拒绝", () => {
    expect(isValidNavUrl(null)).toBe(false);
    expect(isValidNavUrl(123)).toBe(false);
    expect(isValidNavUrl("")).toBe(false);
    expect(isValidNavUrl("not a url")).toBe(false);
  });

  it("超过 MAX_URL_LENGTH 拒绝（防超长 URL 攻击）", () => {
    const long = `https://x/${"a".repeat(MAX_URL_LENGTH)}`;
    expect(long.length).toBeGreaterThan(MAX_URL_LENGTH);
    expect(isValidNavUrl(long)).toBe(false);
  });
});

describe("validateNavAction", () => {
  it("back/forward/reload/stop 仅需 type+threadId+tabId", () => {
    for (const type of ["back", "forward", "reload", "stop"] as const) {
      const r = validateNavAction({ type, threadId: "t", tabId: "tab" });
      expect(r.ok).toBe(true);
      expect(r.action?.type).toBe(type);
    }
  });

  it("navigate 需要合法 http/https URL", () => {
    const ok = validateNavAction({
      type: "navigate",
      threadId: "t",
      tabId: "tab",
      url: "https://x",
    });
    expect(ok.ok).toBe(true);
    if (ok.action?.type === "navigate") expect(ok.action.url).toBe("https://x");

    const bad = validateNavAction({
      type: "navigate",
      threadId: "t",
      tabId: "tab",
      url: "file:///etc/passwd",
    });
    expect(bad.ok).toBe(false);
  });

  it("未知 type 拒绝", () => {
    expect(validateNavAction({ type: "eval", threadId: "t", tabId: "tab" }).ok).toBe(false);
    expect(validateNavAction({ type: 1, threadId: "t", tabId: "tab" }).ok).toBe(false);
  });

  it("threadId / tabId 空或非字符串拒绝", () => {
    expect(validateNavAction({ type: "back", threadId: "", tabId: "tab" }).ok).toBe(false);
    expect(validateNavAction({ type: "back", threadId: "t", tabId: "" }).ok).toBe(false);
    expect(validateNavAction({ type: "back", threadId: 1, tabId: "tab" }).ok).toBe(false);
    expect(validateNavAction({ type: "back", tabId: "tab" }).ok).toBe(false);
  });

  it("非对象输入拒绝", () => {
    expect(validateNavAction(null).ok).toBe(false);
    expect(validateNavAction("x").ok).toBe(false);
    expect(validateNavAction(undefined).ok).toBe(false);
  });
});

describe("normalizeUrl — 地址栏输入补全", () => {
  it("无协议补全 https://", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("  example.com/path  ")).toBe("https://example.com/path");
  });

  it("已有 http/https 协议保持不变", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("HTTPS://Example.com")).toBe("HTTPS://Example.com");
  });

  it("空 / 纯空白返回 null", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
  });

  it("补全后仍非法的输入返回 null（而非拼出危险 URL）", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
  });

  it("域名:端口 不被误判为协议（host:port 仍合法补全）", () => {
    expect(normalizeUrl("example.com:8080")).toBe("https://example.com:8080");
    expect(normalizeUrl("localhost:3000/x")).toBe("https://localhost:3000/x");
  });

  it("超长输入返回 null", () => {
    expect(normalizeUrl("a".repeat(MAX_URL_LENGTH + 10))).toBeNull();
  });
});
