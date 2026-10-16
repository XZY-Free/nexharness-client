import { describe, expect, it } from "vitest";
import {
  extractDocumentRootId,
  extractQueryNodeId,
  mapConsoleType,
  toCdpKeyCode,
} from "./cdp-input";

describe("toCdpKeyCode", () => {
  it("映射常见特殊键", () => {
    expect(toCdpKeyCode("Enter")).toEqual({ key: "Enter", code: "Enter", keyCode: 13 });
    expect(toCdpKeyCode("Tab")).toEqual({ key: "Tab", code: "Tab", keyCode: 9 });
    expect(toCdpKeyCode("Escape")).toEqual({ key: "Escape", code: "Escape", keyCode: 27 });
    expect(toCdpKeyCode("ArrowDown")).toEqual({
      key: "ArrowDown",
      code: "ArrowDown",
      keyCode: 40,
    });
    expect(toCdpKeyCode("PageUp")).toEqual({ key: "PageUp", code: "PageUp", keyCode: 33 });
  });

  it("空格键统一映射为 Space", () => {
    const space = { key: " ", code: "Space", keyCode: 32 };
    expect(toCdpKeyCode("Space")).toEqual(space);
    expect(toCdpKeyCode(" ")).toEqual(space);
  });

  it("单字符键生成 KeyX 代码并保留原字符", () => {
    expect(toCdpKeyCode("a")).toEqual({ key: "a", code: "KeyA", keyCode: 65 });
    expect(toCdpKeyCode("Z")).toEqual({ key: "Z", code: "KeyZ", keyCode: 90 });
    expect(toCdpKeyCode("1")).toEqual({ key: "1", code: "Key1", keyCode: 49 });
  });

  it("未识别的多字符键名原样透传，keyCode 为 0", () => {
    expect(toCdpKeyCode("F13")).toEqual({ key: "F13", code: "F13", keyCode: 0 });
  });
});

describe("mapConsoleType", () => {
  it("已知类型按语义归一", () => {
    expect(mapConsoleType("error")).toBe("error");
    expect(mapConsoleType("warning")).toBe("warning");
    expect(mapConsoleType("warn")).toBe("warning");
    expect(mapConsoleType("info")).toBe("info");
  });

  it("debug / verbose / 未知 / undefined 一律归为 log", () => {
    expect(mapConsoleType("debug")).toBe("log");
    expect(mapConsoleType("verbose")).toBe("log");
    expect(mapConsoleType("nonsense")).toBe("log");
    expect(mapConsoleType(undefined)).toBe("log");
  });
});

describe("extractDocumentRootId — fail-closed", () => {
  it("ok + 有效 root.nodeId → 返回该 id", () => {
    expect(extractDocumentRootId({ ok: true, result: { root: { nodeId: 42 } } })).toBe(42);
  });

  it("ok=false / 无 result / 无 root → null", () => {
    expect(extractDocumentRootId({ ok: false, result: { root: { nodeId: 1 } } })).toBeNull();
    expect(extractDocumentRootId({ ok: true })).toBeNull();
    expect(extractDocumentRootId({ ok: true, result: {} })).toBeNull();
    expect(extractDocumentRootId({ ok: true, result: { root: {} } })).toBeNull();
  });

  it("nodeId=0（CDP 约定的无效值）→ null", () => {
    expect(extractDocumentRootId({ ok: true, result: { root: { nodeId: 0 } } })).toBeNull();
  });

  it("nodeId 非数字 → null（不猜测转换）", () => {
    expect(extractDocumentRootId({ ok: true, result: { root: { nodeId: "42" } } })).toBeNull();
    expect(extractDocumentRootId({ ok: true, result: { root: { nodeId: null } } })).toBeNull();
  });
});

describe("extractQueryNodeId — fail-closed", () => {
  it("ok + 有效 nodeId → 返回", () => {
    expect(extractQueryNodeId({ ok: true, result: { nodeId: 7 } })).toBe(7);
  });

  it("nodeId=0（未匹配）→ null（必须当失败）", () => {
    expect(extractQueryNodeId({ ok: true, result: { nodeId: 0 } })).toBeNull();
  });

  it("ok=false / 无 result / nodeId 缺失或非数字 → null", () => {
    expect(extractQueryNodeId({ ok: false, result: { nodeId: 7 } })).toBeNull();
    expect(extractQueryNodeId({ ok: true })).toBeNull();
    expect(extractQueryNodeId({ ok: true, result: {} })).toBeNull();
    expect(extractQueryNodeId({ ok: true, result: { nodeId: "7" } })).toBeNull();
  });
});
