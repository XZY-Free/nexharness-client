import { describe, expect, it } from "vitest";
import {
  type BrandContract,
  BrandValidationError,
  DEFAULT_BRAND,
  applyBrandPatch,
  mergeBrandOverlay,
  parseBrandPatch,
  validateBrandAssetPath,
} from "./brand-contract";

/**
 * 品牌合同校验防外链注入/路径穿越（logo/icon 路径来自用户输入）。
 * 这些用例锁定：只允许根相对安全图片路径、name 长度约束、patch 不修改入参。
 */
describe("validateBrandAssetPath", () => {
  it("合法根相对图片路径通过并 trim", () => {
    expect(validateBrandAssetPath("/assets/logo.svg", "logo")).toBe("/assets/logo.svg");
    expect(validateBrandAssetPath("  /a/b.png  ", "logo")).toBe("/a/b.png");
    for (const ext of ["svg", "png", "webp", "jpg", "jpeg", "PNG", "SVG"]) {
      expect(validateBrandAssetPath(`/x.${ext}`, "f")).toBe(`/x.${ext}`);
    }
  });

  it("非根相对路径拒绝", () => {
    expect(() => validateBrandAssetPath("assets/logo.svg", "f")).toThrow(BrandValidationError);
    expect(() => validateBrandAssetPath("http://x/a.png", "f")).toThrow();
  });

  it("拒绝 // 开头（协议相对外链）", () => {
    expect(() => validateBrandAssetPath("//evil.com/x.png", "f")).toThrow();
  });

  it("拒绝反斜杠与 .. （路径穿越）", () => {
    expect(() => validateBrandAssetPath("/a\\b.png", "f")).toThrow();
    expect(() => validateBrandAssetPath("/../../etc/x.png", "f")).toThrow();
  });

  it("拒绝携带 scheme（javascript:/data: 注入）", () => {
    expect(() => validateBrandAssetPath("/a.png", "f")).not.toThrow();
    expect(() => validateBrandAssetPath("javascript:alert(1).png", "f")).toThrow();
    // 即使以 / 开头，后段带 scheme 也会被显式拒绝
    expect(() => validateBrandAssetPath("/x", "f")).toThrow(); // 无合法扩展名
  });

  it("非图片扩展名拒绝", () => {
    for (const p of ["/a.html", "/a.js", "/a.exe", "/a", "/a.png.js"]) {
      expect(() => validateBrandAssetPath(p, "f")).toThrow();
    }
  });
});

describe("applyBrandPatch", () => {
  it("合法 patch 应用字段", () => {
    const next = applyBrandPatch(DEFAULT_BRAND, { name: "MyBrand", tagline: "hi" });
    expect(next.name).toBe("MyBrand");
    expect(next.tagline).toBe("hi");
  });

  it("未提供的字段保持 base 值", () => {
    const next = applyBrandPatch(DEFAULT_BRAND, {});
    expect(next.name).toBe(DEFAULT_BRAND.name);
    expect(next.logo).toEqual(DEFAULT_BRAND.logo);
  });

  it("name 长度 1-40 约束", () => {
    expect(() => applyBrandPatch(DEFAULT_BRAND, { name: "" })).toThrow(BrandValidationError);
    expect(() => applyBrandPatch(DEFAULT_BRAND, { name: "x".repeat(41) })).toThrow();
    expect(() => applyBrandPatch(DEFAULT_BRAND, { name: "x".repeat(40) })).not.toThrow();
  });

  it("logo 可为 null（显式清除）", () => {
    const next = applyBrandPatch(DEFAULT_BRAND, { logo: { light: null } });
    expect(next.logo.light).toBeNull();
  });

  it("非法 logo 路径拒绝", () => {
    expect(() =>
      applyBrandPatch(DEFAULT_BRAND, { logo: { light: "http://evil/x.png" } }),
    ).toThrow();
  });

  it("不修改入参", () => {
    const base: BrandContract = JSON.parse(JSON.stringify(DEFAULT_BRAND));
    const snapshot = JSON.stringify(base);
    applyBrandPatch(base, { name: "changed" });
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it("packaging.productName 同样受长度约束", () => {
    expect(() => applyBrandPatch(DEFAULT_BRAND, { packaging: { productName: "" } })).toThrow();
  });
});

describe("mergeBrandOverlay", () => {
  it("overlay 字段覆盖 base", () => {
    const merged = mergeBrandOverlay(DEFAULT_BRAND, { tagline: "overlay" });
    expect(merged.tagline).toBe("overlay");
  });

  it("overlay 里的非法值同样被拒（pin 值也过校验）", () => {
    expect(() => mergeBrandOverlay(DEFAULT_BRAND, { logo: { dark: "/x.exe" } })).toThrow();
  });
});

describe("parseBrandPatch", () => {
  it("合法输入解析为 patch", () => {
    const p = parseBrandPatch({ name: "B", tagline: "t" });
    expect(p.name).toBe("B");
    expect(p.tagline).toBe("t");
  });

  it("忽略未知字段", () => {
    const p = parseBrandPatch({ name: "B", unknownField: "x", injected: "<script>" });
    expect(p.name).toBe("B");
    expect("unknownField" in p).toBe(false);
  });

  it("宽松解析：只挑已知字段，不做类型校验（校验属 applyBrandPatch 职责）", () => {
    // parseBrandPatch 只做字段挑选；非法类型延后到 applyBrandPatch 拒绝
    expect(parseBrandPatch({ name: 123 as never })).toEqual({ name: 123 });
    expect(() => applyBrandPatch(DEFAULT_BRAND, parseBrandPatch({ name: 123 as never }))).toThrow();
  });

  it("非对象输入不抛错但产出空 patch（宽松）", () => {
    expect(parseBrandPatch(null as never)).toEqual({});
    expect(parseBrandPatch("str" as never)).toEqual({});
  });

  it("logo/packaging 子对象逐字段挑选", () => {
    const p = parseBrandPatch({
      logo: { light: "/a.png", extra: 1 },
      packaging: { productName: "P" },
    });
    expect(p.logo).toEqual({ light: "/a.png", dark: undefined });
    expect(p.packaging).toEqual({ productName: "P", appId: undefined, dockLabel: undefined });
  });

  it("空对象解析为空 patch", () => {
    expect(parseBrandPatch({})).toEqual({});
  });
});
