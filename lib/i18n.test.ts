import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_STATUS_LABEL,
  PLAN_ITEM_STATUS_LABEL,
  STATUS_LABEL,
  SUBAGENT_STATUS_LABEL,
  TOOL_LABELS,
  deploymentStatusLabel,
  planItemStatusLabel,
  statusLabel,
  subagentStatusLabel,
  t,
  toolLabel,
} from "./i18n";

/**
 * i18n 字典是 UI 文案的唯一出口。
 * 这些用例锁定：缺 key 回退（fail-open 不抛错）、变量插值、未知值原样返回。
 */
describe("t() — 查表与插值", () => {
  it("已知 key 返回文案", () => {
    const out = t("common.realtime");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("未知 key 返回 key 本身（fail-open，便于发现遗漏）", () => {
    expect(t("nonexistent.key.xyz")).toBe("nonexistent.key.xyz");
  });

  it("无 vars 时模板原样返回", () => {
    const out = t("nonexistent.no.vars");
    expect(out).toBe("nonexistent.no.vars");
  });

  it("vars 插值替换 {name} 占位", () => {
    // 用一个真实的带占位符 key（若存在）；否则验证注入逻辑在未知 key 上无副作用
    const out = t("common.realtime", { name: "X" });
    expect(typeof out).toBe("string");
  });

  it("vars 中缺失的占位符保留原样（不替换为 undefined）", () => {
    const out = t("nonexistent.{missing}", { other: "x" });
    expect(out).toBe("nonexistent.{missing}");
  });

  it("插值值支持数字", () => {
    const out = t("k.{n}", { n: 42 });
    expect(out).toBe("k.42");
  });
});

describe("statusLabel（thread 状态）", () => {
  it("已知 thread 状态返回中文标签", () => {
    expect(statusLabel("executing")).toBe("执行中");
    expect(statusLabel("ready_for_review")).toBe("待审核");
    expect(statusLabel("completed")).toBe("已交付");
  });

  it("未知状态原样返回", () => {
    expect(statusLabel("unknown_state")).toBe("unknown_state");
  });

  it("字典中每个 key 都返回非空标签", () => {
    for (const [key, label] of Object.entries(STATUS_LABEL)) {
      expect(statusLabel(key)).toBe(label);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("subagentStatusLabel", () => {
  it("已知状态返回中文", () => {
    expect(subagentStatusLabel("queued")).toBe("排队");
    expect(subagentStatusLabel("timed_out")).toBe("超时");
  });

  it("未知原样返回", () => {
    expect(subagentStatusLabel("nope")).toBe("nope");
  });

  it("字典全覆盖", () => {
    for (const [key, label] of Object.entries(SUBAGENT_STATUS_LABEL)) {
      expect(subagentStatusLabel(key)).toBe(label);
    }
  });
});

describe("planItemStatusLabel / deploymentStatusLabel", () => {
  it("plan item 状态映射", () => {
    expect(planItemStatusLabel("pending")).toBe("待处理");
    expect(planItemStatusLabel("in_progress")).toBe("进行中");
    expect(planItemStatusLabel("nope")).toBe("nope");
  });

  it("deployment 状态映射", () => {
    expect(deploymentStatusLabel("deployed")).toBe("已部署");
    expect(deploymentStatusLabel("rolled_back")).toBe("已回滚");
    expect(deploymentStatusLabel("nope")).toBe("nope");
  });

  it("两个字典全覆盖", () => {
    for (const [k, v] of Object.entries(PLAN_ITEM_STATUS_LABEL)) {
      expect(planItemStatusLabel(k)).toBe(v);
    }
    for (const [k, v] of Object.entries(DEPLOYMENT_STATUS_LABEL)) {
      expect(deploymentStatusLabel(k)).toBe(v);
    }
  });
});

describe("toolLabel", () => {
  it("已知工具名返回友好标签", () => {
    const keys = Object.keys(TOOL_LABELS);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(toolLabel(k)).toBe(TOOL_LABELS[k]);
    }
  });

  it("未知工具名原样返回", () => {
    expect(toolLabel("totally_unknown_tool")).toBe("totally_unknown_tool");
  });
});

describe("字典完整性", () => {
  it("所有状态字典的值为非空字符串", () => {
    for (const dict of [
      STATUS_LABEL,
      SUBAGENT_STATUS_LABEL,
      PLAN_ITEM_STATUS_LABEL,
      DEPLOYMENT_STATUS_LABEL,
      TOOL_LABELS,
    ]) {
      for (const v of Object.values(dict)) {
        expect(typeof v).toBe("string");
        expect(v.length).toBeGreaterThan(0);
      }
    }
  });
});
