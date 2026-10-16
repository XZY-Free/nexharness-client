import { describe, expect, it, vi } from "vitest";
import {
  SNAPSHOT_EXPRESSION,
  capturePageSnapshot,
  parseSnapshotResult,
  truncateSnapshotText,
} from "./snapshot";

/**
 * 页面快照：采集脚本 + 结果解析 + 截断。
 * 这些用例锁定：截断边界（含恰好等于上限）、畸形返回一律 null（fail-closed）、
 * 采集脚本不含外部输入（注入面固化）。
 */
describe("SNAPSHOT_EXPRESSION — 安全约束", () => {
  it("不包含 HTML 导出（只允许结构化摘要）", () => {
    expect(SNAPSHOT_EXPRESSION).not.toContain("outerHTML");
    expect(SNAPSHOT_EXPRESSION).not.toContain("innerHTML");
    expect(SNAPSHOT_EXPRESSION).not.toContain("documentElement");
  });

  it("采集 innerText 与结构化计数", () => {
    expect(SNAPSHOT_EXPRESSION).toContain("body.innerText");
    expect(SNAPSHOT_EXPRESSION).toContain("linkCount");
    expect(SNAPSHOT_EXPRESSION).toContain("formCount");
    expect(SNAPSHOT_EXPRESSION).toContain("inputCount");
    expect(SNAPSHOT_EXPRESSION).toContain("imgCount");
  });

  it("无 body 时返回空结构而非抛错", () => {
    expect(SNAPSHOT_EXPRESSION).toContain("if (!body) return");
  });

  it("是固定字面量：函数无参数（不接受外部拼接）", () => {
    expect(SNAPSHOT_EXPRESSION.startsWith("(function() {")).toBe(true);
  });
});

describe("truncateSnapshotText", () => {
  it("未给上限 / 0 / 负数 → 不截断", () => {
    expect(truncateSnapshotText("abc")).toBe("abc");
    expect(truncateSnapshotText("abc", 0)).toBe("abc");
    expect(truncateSnapshotText("abc", -1)).toBe("abc");
    expect(truncateSnapshotText("abc", null)).toBe("abc");
  });

  it("未超上限 → 不截断", () => {
    expect(truncateSnapshotText("abc", 10)).toBe("abc");
  });

  it("恰好等于上限 → 不截断（边界）", () => {
    expect(truncateSnapshotText("abcde", 5)).toBe("abcde");
  });

  it("超上限 → 截断且总长恰为上限（... 占 3 字符）", () => {
    const out = truncateSnapshotText("abcdefghij", 6);
    expect(out).toBe("abc...");
    expect(out.length).toBe(6);
  });

  it("上限小于 3 → slice 负索引，仍不抛（行为记录）", () => {
    expect(() => truncateSnapshotText("abcdef", 2)).not.toThrow();
  });
});

describe("parseSnapshotResult — fail-closed", () => {
  const good = JSON.stringify({ text: "hi", domSummary: '{"a":1}' });

  it("合法返回 → 解析成功", () => {
    expect(parseSnapshotResult({ ok: true, result: { result: { value: good } } })).toEqual({
      text: "hi",
      domSummary: '{"a":1}',
    });
  });

  it("ok=false → null", () => {
    expect(parseSnapshotResult({ ok: false, result: { result: { value: good } } })).toBeNull();
  });

  it("result 缺失 → null", () => {
    expect(parseSnapshotResult({ ok: true })).toBeNull();
    expect(parseSnapshotResult({ ok: true, result: {} })).toBeNull();
    expect(parseSnapshotResult({ ok: true, result: { result: {} } })).toBeNull();
  });

  it("value 非字符串 → null", () => {
    expect(parseSnapshotResult({ ok: true, result: { result: { value: 42 } } })).toBeNull();
    expect(parseSnapshotResult({ ok: true, result: { result: { value: null } } })).toBeNull();
  });

  it("JSON 非法 → null（不抛）", () => {
    expect(
      parseSnapshotResult({ ok: true, result: { result: { value: "not json{" } } }),
    ).toBeNull();
  });

  it("形状不对（缺 text/domSummary 或类型错）→ null", () => {
    expect(
      parseSnapshotResult({
        ok: true,
        result: { result: { value: JSON.stringify({ text: "x" }) } },
      }),
    ).toBeNull();
    expect(
      parseSnapshotResult({
        ok: true,
        result: { result: { value: JSON.stringify({ text: 1, domSummary: "x" }) } },
      }),
    ).toBeNull();
    expect(
      parseSnapshotResult({ ok: true, result: { result: { value: JSON.stringify("str") } } }),
    ).toBeNull();
    expect(
      parseSnapshotResult({ ok: true, result: { result: { value: JSON.stringify(null) } } }),
    ).toBeNull();
  });
});

describe("capturePageSnapshot", () => {
  it("发出 Runtime.evaluate（returnByValue）+ 解析 + 截断", async () => {
    const send = vi.fn(async () => ({
      ok: true,
      result: { result: { value: JSON.stringify({ text: "abcdefghij", domSummary: "{}" }) } },
    }));
    const out = await capturePageSnapshot({ sendCommand: send }, 6);
    expect(send).toHaveBeenCalledWith("Runtime.evaluate", {
      expression: SNAPSHOT_EXPRESSION,
      returnByValue: true,
    });
    expect(out).toEqual({ text: "abc...", domSummary: "{}" });
  });

  it("CDP 失败 → null", async () => {
    const send = vi.fn(async () => ({ ok: false }));
    expect(await capturePageSnapshot({ sendCommand: send })).toBeNull();
  });

  it("不传上限 → 不截断", async () => {
    const send = vi.fn(async () => ({
      ok: true,
      result: { result: { value: JSON.stringify({ text: "long text here", domSummary: "{}" }) } },
    }));
    expect((await capturePageSnapshot({ sendCommand: send }))?.text).toBe("long text here");
  });
});
