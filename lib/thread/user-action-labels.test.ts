import { describe, expect, it } from "vitest";
import {
  PREVIEW_FIELD_LABELS,
  formatExpiresAt,
  getRequestTypeLabel,
  getResolutionLabel,
  previewFieldLabel,
} from "./user-action-labels";

/**
 * UserAction 文案映射与时间格式化。
 * 这些用例锁定：未知值兜底（不暴露裸技术键）、倒计时分档、已超时判定。
 */
describe("getRequestTypeLabel", () => {
  it("四类请求类型有中文文案", () => {
    expect(getRequestTypeLabel("confirmation")).toBe("确认请求");
    expect(getRequestTypeLabel("auth")).toBe("授权请求");
    expect(getRequestTypeLabel("grant")).toBe("权限授予请求");
    expect(getRequestTypeLabel("input")).toBe("输入请求");
  });

  it("未知 / undefined → 通用文案", () => {
    expect(getRequestTypeLabel("unknown")).toBe("操作请求");
    expect(getRequestTypeLabel(undefined)).toBe("操作请求");
  });
});

describe("getResolutionLabel", () => {
  it("四种 resolution 有中文文案", () => {
    expect(getResolutionLabel("approve")).toBe("已同意");
    expect(getResolutionLabel("deny")).toBe("已拒绝");
    expect(getResolutionLabel("submit")).toBe("已提交");
    expect(getResolutionLabel("cancel")).toBe("已取消");
  });

  it("null → 已解析（兜底）", () => {
    expect(getResolutionLabel(null)).toBe("已解析");
  });
});

describe("formatExpiresAt", () => {
  it("undefined / 非法时间 → null", () => {
    expect(formatExpiresAt(undefined)).toBeNull();
    expect(formatExpiresAt("")).toBeNull();
    expect(formatExpiresAt("not-a-date")).toBeNull();
  });

  it("已过去 → 已超时", () => {
    expect(formatExpiresAt(new Date(Date.now() - 60_000).toISOString())).toBe("已超时");
  });

  it("分钟内 → N 分钟后超时", () => {
    expect(formatExpiresAt(new Date(Date.now() + 5 * 60_000).toISOString())).toBe("5 分钟后超时");
  });

  it("小时内 → N 小时后超时", () => {
    expect(formatExpiresAt(new Date(Date.now() + 3 * 3_600_000).toISOString())).toBe(
      "3 小时后超时",
    );
  });

  it("超过一天 → N 天后超时", () => {
    expect(formatExpiresAt(new Date(Date.now() + 2 * 86_400_000).toISOString())).toBe("2 天后超时");
  });
});

describe("previewFieldLabel", () => {
  it("已知键用中文标签", () => {
    expect(previewFieldLabel("leave_type", 0)).toBe("假期类型");
    expect(previewFieldLabel("amount", 3)).toBe("金额");
  });

  it("未知键用序号（不暴露裸技术键）", () => {
    expect(previewFieldLabel("some_internal_key", 0)).toBe("信息 1");
    expect(previewFieldLabel("another", 4)).toBe("信息 5");
  });

  it("字典无空值", () => {
    for (const [k, v] of Object.entries(PREVIEW_FIELD_LABELS)) {
      expect(k.length).toBeGreaterThan(0);
      expect(v.length).toBeGreaterThan(0);
    }
  });
});
