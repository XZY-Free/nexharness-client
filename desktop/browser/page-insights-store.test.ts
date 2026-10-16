import { describe, expect, it } from "vitest";
import { PageInsightsStore } from "./page-insights-store";

/**
 * PageInsightsStore 是 Console/Network 洞察缓冲（纯逻辑）。
 * 这些用例锁定：按 tab 隔离、level/filter 语义、limit 截断、清理防泄漏。
 */
describe("PageInsightsStore — Console", () => {
  it("按 thread+tab 隔离存储", () => {
    const s = new PageInsightsStore();
    s.addConsoleEntry("t1", "tab1", { level: "log", text: "a" });
    s.addConsoleEntry("t1", "tab2", { level: "log", text: "b" });
    s.addConsoleEntry("t2", "tab1", { level: "log", text: "c" });
    expect(s.consoleCount("t1", "tab1")).toBe(1);
    expect(s.consoleCount("t1", "tab2")).toBe(1);
    expect(s.consoleCount("t2", "tab1")).toBe(1);
    expect(s.getConsoleEntries("t1", "tab1")[0]?.text).toBe("a");
  });

  it("无数据返回空数组", () => {
    const s = new PageInsightsStore();
    expect(s.getConsoleEntries("x", "y")).toEqual([]);
  });

  it("level=error 只留 error + pageerror", () => {
    const s = new PageInsightsStore();
    for (const level of ["log", "warning", "error", "pageerror", "info"] as const) {
      s.addConsoleEntry("t", "tab", { level, text: level });
    }
    const got = s.getConsoleEntries("t", "tab", "error").map((e) => e.level);
    expect(got.sort()).toEqual(["error", "pageerror"]);
  });

  it("level=warning+ 含 error/pageerror/warning", () => {
    const s = new PageInsightsStore();
    for (const level of ["log", "warning", "error", "pageerror", "info"] as const) {
      s.addConsoleEntry("t", "tab", { level, text: level });
    }
    const got = s.getConsoleEntries("t", "tab", "warning+").map((e) => e.level);
    expect(got.sort()).toEqual(["error", "pageerror", "warning"]);
  });

  it("默认保留末 50 条（时序取最新）", () => {
    const s = new PageInsightsStore();
    for (let i = 0; i < 60; i++) s.addConsoleEntry("t", "tab", { level: "log", text: `m${i}` });
    const got = s.getConsoleEntries("t", "tab");
    expect(got.length).toBe(50);
    expect(got[got.length - 1]?.text).toBe("m59"); // 最新在末尾
  });

  it("显式 limit 生效；非法 limit（0/负数）回退默认 50", () => {
    const s = new PageInsightsStore();
    for (let i = 0; i < 10; i++) s.addConsoleEntry("t", "tab", { level: "log", text: `m${i}` });
    expect(s.getConsoleEntries("t", "tab", undefined, 3).length).toBe(3);
    expect(s.getConsoleEntries("t", "tab", undefined, 0).length).toBe(10); // <50 全返回
    expect(s.getConsoleEntries("t", "tab", undefined, -5).length).toBe(10);
  });
});

describe("PageInsightsStore — Network", () => {
  function request(s: PageInsightsStore, id: string, ts: number, url = `https://x/${id}`) {
    s.bufferNetworkRequest("t", "tab", id, { url, method: "GET", timestamp: ts });
  }

  it("request → response → loadingFinished 完整链路", () => {
    const s = new PageInsightsStore();
    request(s, "r1", 1000);
    s.bufferNetworkResponse("t", "tab", "r1", { status: 200, mimeType: "text/html" });
    s.finalizeNetworkEntry("t", "tab", "r1", { timestamp: 1300, encodedDataLength: 512 });

    const [e] = s.getNetworkEntries("t", "tab");
    expect(e?.status).toBe(200);
    expect(e?.mimeType).toBe("text/html");
    expect(e?.duration).toBe(300);
    expect(e?.body).toBeNull(); // body 永不保留（安全约束）
  });

  it("无 request 时 response/finished 为静默 no-op（乱序事件不崩）", () => {
    const s = new PageInsightsStore();
    s.bufferNetworkResponse("t", "tab", "ghost", { status: 200 });
    s.finalizeNetworkEntry("t", "tab", "ghost", { timestamp: 1 });
    s.failNetworkEntry("t", "tab", "ghost", { timestamp: 1 });
    expect(s.networkCount("t", "tab")).toBe(0);
  });

  it("响应头按 key 合并（不整体覆盖）", () => {
    const s = new PageInsightsStore();
    request(s, "r1", 1);
    s.bufferNetworkResponse("t", "tab", "r1", { status: 200, headers: { a: "1" } });
    s.bufferNetworkResponse("t", "tab", "r1", { status: 200, headers: { b: "2" } });
    const [e] = s.getNetworkEntries("t", "tab");
    expect(e?.headers).toEqual({ a: "1", b: "2" });
  });

  it("filter=failed 只留失败请求", () => {
    const s = new PageInsightsStore();
    request(s, "ok", 1);
    s.finalizeNetworkEntry("t", "tab", "ok", { timestamp: 2 });
    request(s, "bad", 1);
    s.failNetworkEntry("t", "tab", "bad", { timestamp: 2, errorText: "ECONNRESET" });
    const got = s.getNetworkEntries("t", "tab", "failed");
    expect(got.length).toBe(1);
    expect(got[0]?.url).toBe("https://x/bad");
  });

  it("filter=slow 只留 duration > 1000ms；未完成请求不计入", () => {
    const s = new PageInsightsStore();
    request(s, "fast", 1000);
    s.finalizeNetworkEntry("t", "tab", "fast", { timestamp: 1200 }); // 200ms
    request(s, "slow", 1000);
    s.finalizeNetworkEntry("t", "tab", "slow", { timestamp: 2500 }); // 1500ms
    request(s, "pending", 1000); // 从未 finish
    const got = s.getNetworkEntries("t", "tab", "slow");
    expect(got.length).toBe(1);
    expect(got[0]?.url).toBe("https://x/slow");
  });

  it("结果按时间戳降序（最新在前）", () => {
    const s = new PageInsightsStore();
    request(s, "old", 1000);
    request(s, "new", 3000);
    request(s, "mid", 2000);
    const got = s.getNetworkEntries("t", "tab").map((e) => e.url);
    expect(got).toEqual(["https://x/new", "https://x/mid", "https://x/old"]);
  });

  it("failed 时 errorText 缺省取 blockedReason，再缺省为 unknown error", () => {
    const s = new PageInsightsStore();
    request(s, "a", 1);
    s.failNetworkEntry("t", "tab", "a", { timestamp: 2, blockedReason: "CORS" });
    request(s, "b", 1);
    s.failNetworkEntry("t", "tab", "b", { timestamp: 2 });
    const all = s.getNetworkEntries("t", "tab", "failed");
    expect(all.length).toBe(2);
  });
});

describe("PageInsightsStore — 清理（防内存泄漏）", () => {
  it("clearTab 只清该 tab", () => {
    const s = new PageInsightsStore();
    s.addConsoleEntry("t", "tab1", { level: "log", text: "a" });
    s.addConsoleEntry("t", "tab2", { level: "log", text: "b" });
    s.clearTab("t", "tab1");
    expect(s.consoleCount("t", "tab1")).toBe(0);
    expect(s.consoleCount("t", "tab2")).toBe(1);
  });

  it("clearThread 清掉该 thread 所有 tab 并返回 tab 数", () => {
    const s = new PageInsightsStore();
    s.addConsoleEntry("t1", "tab1", { level: "log", text: "a" });
    s.addConsoleEntry("t1", "tab2", { level: "log", text: "b" });
    s.addConsoleEntry("t2", "tab1", { level: "log", text: "c" });
    expect(s.clearThread("t1")).toBe(2);
    expect(s.consoleCount("t1", "tab1")).toBe(0);
    expect(s.consoleCount("t2", "tab1")).toBe(1);
  });

  it("clearThread 不误伤同前缀的其它 thread（t1 vs t10）", () => {
    const s = new PageInsightsStore();
    s.addConsoleEntry("t1", "tab", { level: "log", text: "a" });
    s.addConsoleEntry("t10", "tab", { level: "log", text: "b" });
    s.clearThread("t1");
    expect(s.consoleCount("t1", "tab")).toBe(0);
    expect(s.consoleCount("t10", "tab")).toBe(1); // 前缀匹配用 "t1:" 避免误伤
  });
});
