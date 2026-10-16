import { describe, expect, it } from "vitest";
import {
  type InputFieldDef,
  defaultFieldLabel,
  extractInputFields,
  isStructuredPreview,
  normalizeFieldValue,
  previewText,
} from "./user-action-fields";

/**
 * UserAction input_schema 解析与客户端校验是**安全边界**（fail-closed）。
 * 这些用例锁定：非法 schema 整体拒绝、归一化拒绝宽松处理、预览不越界。
 */
function field(over: Partial<InputFieldDef> = {}): InputFieldDef {
  return { key: "k", label: "K", type: "string", required: false, ...over };
}

describe("extractInputFields — fail-closed", () => {
  it("合法 schema 提取字段", () => {
    const r = extractInputFields({
      type: "object",
      properties: {
        text: { type: "string", title: "补充信息", minLength: 2 },
        days: { type: "integer", description: "天数" },
      },
      required: ["text"],
    });
    expect(r.ok).toBe(true);
    expect(r.fields.length).toBe(2);
    const [f0, f1] = r.fields;
    expect(f0?.key).toBe("text");
    expect(f0?.label).toBe("补充信息");
    expect(f0?.required).toBe(true);
    expect(f0?.minLength).toBe(2);
    expect(f1?.key).toBe("days");
    expect(f1?.label).toBe("天数");
    expect(f1?.required).toBe(false);
  });

  it("schema 缺失 / 非对象 / 空 properties → fail", () => {
    expect(extractInputFields(undefined).ok).toBe(false);
    expect(extractInputFields(null as never).ok).toBe(false);
    expect(extractInputFields("str" as never).ok).toBe(false);
    expect(extractInputFields({}).ok).toBe(false);
    expect(extractInputFields({ properties: {} }).ok).toBe(false);
  });

  it("字段类型不支持 → 整体 fail（不跳过坏字段）", () => {
    const r = extractInputFields({
      properties: { good: { type: "string" }, bad: { type: "array" } },
    });
    expect(r.ok).toBe(false);
    expect(r.fields).toEqual([]);
  });

  it("字段定义非对象 → 整体 fail", () => {
    expect(extractInputFields({ properties: { a: null } }).ok).toBe(false);
    expect(extractInputFields({ properties: { a: "str" } }).ok).toBe(false);
  });

  it("非法正则 → 整体 fail（与 UI/服务端口径一致）", () => {
    const r = extractInputFields({
      properties: { a: { type: "string", pattern: "([unclosed" } },
    });
    expect(r.ok).toBe(false);
  });

  it("合法正则保留", () => {
    const r = extractInputFields({ properties: { a: { type: "string", pattern: "^\\d+$" } } });
    expect(r.ok).toBe(true);
    expect(r.fields[0]?.pattern).toBe("^\\d+$");
  });

  it("title 缺失时用 description，再缺失用默认序号标签", () => {
    const r = extractInputFields({
      properties: { a: { description: "描述" }, b: {}, text: {} },
    });
    expect(r.fields[0]?.label).toBe("描述");
    expect(r.fields[1]?.label).toBe("输入项 2");
    expect(r.fields[2]?.label).toBe("补充信息"); // key==="text" 的特例
  });

  it("enum 非数组时忽略（不当枚举校验）", () => {
    const r = extractInputFields({ properties: { a: { type: "string", enum: "x" } } });
    expect(r.fields[0]?.enum).toBeUndefined();
  });

  it("required 非数组时视为无必填", () => {
    const r = extractInputFields({
      properties: { a: { type: "string" } },
      required: "a" as never,
    });
    expect(r.fields[0]?.required).toBe(false);
  });
});

describe("normalizeFieldValue — 归一与校验", () => {
  it("可选字段留空 → omit", () => {
    expect(normalizeFieldValue(field(), "  ")).toEqual({ ok: true, omit: true });
  });

  it("必填字段留空 → 非法", () => {
    expect(normalizeFieldValue(field({ required: true }), "")).toEqual({ ok: false });
  });

  it("可选字段填值 → 提交 trim 后的字符串", () => {
    expect(normalizeFieldValue(field(), "  hi  ")).toEqual({ ok: true, omit: false, value: "hi" });
  });

  it("number 真转数字；非法数字拒绝", () => {
    const f = field({ type: "number" });
    expect(normalizeFieldValue(f, "42")).toEqual({ ok: true, omit: false, value: 42 });
    expect(normalizeFieldValue(f, "1.5")).toEqual({ ok: true, omit: false, value: 1.5 });
    expect(normalizeFieldValue(f, "abc")).toEqual({ ok: false });
    expect(normalizeFieldValue(f, "NaN")).toEqual({ ok: false });
  });

  it("integer 拒绝小数", () => {
    const f = field({ type: "integer" });
    expect(normalizeFieldValue(f, "3")).toEqual({ ok: true, omit: false, value: 3 });
    expect(normalizeFieldValue(f, "3.5")).toEqual({ ok: false });
  });

  it("boolean 只接受 true/false 字面量（防杂串归一为 false）", () => {
    const f = field({ type: "boolean" });
    expect(normalizeFieldValue(f, "true")).toEqual({ ok: true, omit: false, value: true });
    expect(normalizeFieldValue(f, "false")).toEqual({ ok: true, omit: false, value: false });
    expect(normalizeFieldValue(f, "yes")).toEqual({ ok: false });
    expect(normalizeFieldValue(f, "1")).toEqual({ ok: false });
    expect(normalizeFieldValue(f, "")).toEqual({ ok: true, omit: true });
  });

  it("boolean 必填留空 → 非法", () => {
    expect(normalizeFieldValue(field({ type: "boolean", required: true }), "")).toEqual({
      ok: false,
    });
  });

  it("enum 校验（不在枚举内拒绝）", () => {
    const f = field({ enum: ["a", "b"] as const });
    expect(normalizeFieldValue(f, "a").ok).toBe(true);
    expect(normalizeFieldValue(f, "c")).toEqual({ ok: false });
  });

  it("minLength / maxLength 校验", () => {
    expect(normalizeFieldValue(field({ minLength: 3 }), "ab")).toEqual({ ok: false });
    expect(normalizeFieldValue(field({ minLength: 3 }), "abc").ok).toBe(true);
    expect(normalizeFieldValue(field({ maxLength: 2 }), "abc")).toEqual({ ok: false });
  });

  it("pattern 校验", () => {
    const f = field({ pattern: "^\\d{3}$" });
    expect(normalizeFieldValue(f, "123").ok).toBe(true);
    expect(normalizeFieldValue(f, "12")).toEqual({ ok: false });
  });

  it("校验用 trim 后的值（前后空白不影响 minLength 判定）", () => {
    expect(normalizeFieldValue(field({ minLength: 3 }), "  abc  ").ok).toBe(true);
  });
});

describe("isStructuredPreview — 预览边界", () => {
  it("对象（非数组、1~8 键）为结构化预览", () => {
    expect(isStructuredPreview({ a: 1 })).toBe(true);
    expect(isStructuredPreview({ a: 1, b: 2 })).toBe(true);
  });

  it("空对象 / 数组 / null / 原始值 / 超 8 键 拒绝", () => {
    expect(isStructuredPreview({})).toBe(false);
    expect(isStructuredPreview([])).toBe(false);
    expect(isStructuredPreview(null)).toBe(false);
    expect(isStructuredPreview("str")).toBe(false);
    expect(isStructuredPreview(42)).toBe(false);
    const big: Record<string, number> = {};
    for (let i = 0; i < 9; i++) big[`k${i}`] = i;
    expect(isStructuredPreview(big)).toBe(false);
  });
});

describe("previewText", () => {
  it("短文本原样，长文本截断加省略号", () => {
    expect(previewText("short")).toBe("short");
    const long = "x".repeat(600);
    const out = previewText(long);
    expect(out.length).toBe(501); // 500 + "…"
    expect(out.endsWith("…")).toBe(true);
  });

  it("恰好 500 字符不截断", () => {
    const exact = "x".repeat(500);
    expect(previewText(exact)).toBe(exact);
  });
});

describe("defaultFieldLabel", () => {
  it("text 键 → 补充信息；其它 → 输入项 N", () => {
    expect(defaultFieldLabel("text", 0)).toBe("补充信息");
    expect(defaultFieldLabel("foo", 0)).toBe("输入项 1");
    expect(defaultFieldLabel("bar", 2)).toBe("输入项 3");
  });
});
