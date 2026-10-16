import { describe, expect, it } from "vitest";
import {
  DECISION_RANK,
  type PolicyEvaluatorInput,
  type PolicyRuleView,
  evaluatePolicy,
  matchPolicyPattern,
  sortPolicyRules,
  tighterDecision,
} from "./policy-evaluator";

/**
 * 策略评估是「AI 工具调用是否放行」的判定核心，fail-closed。
 * 这些用例锁定：block 永不降级、Agent 只能收紧、Grant 只补允许缺口、ReDoS 防护。
 */
function rule(over: Partial<PolicyRuleView> = {}): PolicyRuleView {
  return {
    ruleKey: "r1",
    toolPattern: "tool.writeFile",
    argMatcher: null,
    decision: "allow",
    scope: null,
    priority: 0,
    ...over,
  };
}

function input(over: Partial<PolicyEvaluatorInput> = {}): PolicyEvaluatorInput {
  return {
    toolKey: "tool.writeFile",
    arguments: {},
    toolRiskClass: null,
    scopeContext: {},
    defaultDecision: "allow",
    rules: [],
    agentRequirements: null,
    grantScopes: [],
    ...over,
  };
}

describe("tighterDecision / DECISION_RANK", () => {
  it("强度序 block > pause > allow", () => {
    expect(DECISION_RANK.block).toBeGreaterThan(DECISION_RANK.pause);
    expect(DECISION_RANK.pause).toBeGreaterThan(DECISION_RANK.allow);
  });

  it("返回更严格者，对称且幂等", () => {
    expect(tighterDecision("allow", "block")).toBe("block");
    expect(tighterDecision("block", "allow")).toBe("block");
    expect(tighterDecision("allow", "pause")).toBe("pause");
    expect(tighterDecision("pause", "pause")).toBe("pause");
    expect(tighterDecision("block", "pause")).toBe("block");
  });
});

describe("matchPolicyPattern", () => {
  it("* 匹配全部", () => {
    expect(matchPolicyPattern("*", "tool.anything")).toBe(true);
  });

  it("prefix.* 匹配该前缀下一层以上", () => {
    expect(matchPolicyPattern("tool.*", "tool.writeFile")).toBe(true);
    expect(matchPolicyPattern("tool.*", "tool.a.b")).toBe(true);
    expect(matchPolicyPattern("mcp.*", "tool.writeFile")).toBe(false);
  });

  it("完整 key 精确匹配", () => {
    expect(matchPolicyPattern("tool.writeFile", "tool.writeFile")).toBe(true);
    expect(matchPolicyPattern("tool.writeFile", "tool.readFile")).toBe(false);
  });

  it("裸名等价 tool.<name>", () => {
    expect(matchPolicyPattern("writeFile", "tool.writeFile")).toBe(true);
    expect(matchPolicyPattern("writeFile", "writeFile")).toBe(false);
  });

  it("已带已知前缀原样（tool./mcp./web./docs./custom./external.）", () => {
    expect(matchPolicyPattern("mcp.server", "mcp.server")).toBe(true);
    expect(matchPolicyPattern("external.api", "external.api")).toBe(true);
  });
});

describe("sortPolicyRules — canonical 顺序", () => {
  it("priority DESC 优先", () => {
    const sorted = sortPolicyRules([
      rule({ ruleKey: "a", priority: 1 }),
      rule({ ruleKey: "b", priority: 5 }),
    ]);
    expect(sorted.map((r) => r.ruleKey)).toEqual(["b", "a"]);
  });

  it("同 priority 时 block > pause > allow", () => {
    const sorted = sortPolicyRules([
      rule({ ruleKey: "allow", decision: "allow" }),
      rule({ ruleKey: "block", decision: "block" }),
      rule({ ruleKey: "pause", decision: "pause" }),
    ]);
    expect(sorted.map((r) => r.decision)).toEqual(["block", "pause", "allow"]);
  });

  it("同 priority 同 decision 时按 toolPattern 再按 ruleKey 排序", () => {
    const sorted = sortPolicyRules([
      rule({ ruleKey: "z", toolPattern: "tool.z" }),
      rule({ ruleKey: "a", toolPattern: "tool.a" }),
    ]);
    expect(sorted.map((r) => r.toolPattern)).toEqual(["tool.a", "tool.z"]);
  });

  it("不修改入参", () => {
    const rules = [rule({ priority: 1 }), rule({ priority: 5 })];
    sortPolicyRules(rules);
    expect(rules[0]?.priority).toBe(1);
  });
});

describe("evaluatePolicy — 决策合成", () => {
  it("无规则命中走 defaultDecision", () => {
    expect(evaluatePolicy(input({ defaultDecision: "allow" })).decision).toBe("allow");
    expect(evaluatePolicy(input({ defaultDecision: "pause" })).decision).toBe("pause");
    expect(evaluatePolicy(input({ defaultDecision: "block" })).decision).toBe("block");
  });

  it("命中规则取该规则决策", () => {
    const r = evaluatePolicy(input({ rules: [rule({ decision: "pause" })] }));
    expect(r.decision).toBe("pause");
    expect(r.matchedRule?.ruleKey).toBe("r1");
  });

  it("平台强制规则命中 → 立即 block（最顶，不管 Policy/Agent）", () => {
    const r = evaluatePolicy(
      input({
        platformRules: [rule({ ruleKey: "plat", decision: "pause" })],
        defaultDecision: "allow",
      }),
    );
    expect(r.decision).toBe("block");
    expect(r.matchedRule?.ruleKey).toBe("plat");
  });

  it("Policy block 永不降级（忽略 Agent / Grant）", () => {
    const r = evaluatePolicy(
      input({
        rules: [rule({ decision: "block" })],
        grantScopes: ["tool:execute"],
      }),
    );
    expect(r.decision).toBe("block");
    expect(r.grantSatisfied).toBe(false);
  });

  it("Agent toolRiskMax 收紧为 pause（只收紧，不产生 block）", () => {
    const r = evaluatePolicy(
      input({
        defaultDecision: "allow",
        toolRiskClass: "critical",
        agentRequirements: { toolRiskMax: "low" },
      }),
    );
    expect(r.decision).toBe("pause");
    expect(r.agentGated).toBe(true);
  });

  it("工具风险未超上限时不收紧", () => {
    const r = evaluatePolicy(
      input({ toolRiskClass: "low", agentRequirements: { toolRiskMax: "high" } }),
    );
    expect(r.decision).toBe("allow");
    expect(r.agentGated).toBe(false);
  });

  it("Agent 不能放宽 Policy 的 pause", () => {
    const r = evaluatePolicy(
      input({ rules: [rule({ decision: "pause" })], agentRequirements: { toolRiskMax: "high" } }),
    );
    expect(r.decision).toBe("pause");
  });

  it("Grant 把 pause 满足为 allow（只补允许缺口）", () => {
    const r = evaluatePolicy(
      input({ defaultDecision: "pause", grantScopes: ["tool:tool.writeFile"] }),
    );
    expect(r.decision).toBe("allow");
    expect(r.grantSatisfied).toBe(true);
  });

  it("tool:execute 全局 Grant 覆盖任意工具", () => {
    const r = evaluatePolicy(input({ defaultDecision: "pause", grantScopes: ["tool:execute"] }));
    expect(r.decision).toBe("allow");
  });

  it("<key>:execute 前缀 Grant 覆盖对应工具", () => {
    const r = evaluatePolicy(
      input({
        toolKey: "tool.writeFile",
        defaultDecision: "pause",
        grantScopes: ["tool.writeFile:execute"],
      }),
    );
    expect(r.decision).toBe("allow");
  });

  it("无关 Grant 不满足缺口", () => {
    const r = evaluatePolicy(
      input({ toolKey: "tool.writeFile", defaultDecision: "pause", grantScopes: ["tool.other"] }),
    );
    expect(r.decision).toBe("pause");
    expect(r.grantSatisfied).toBe(false);
  });

  it("reasonCodes 与 decisionSummary 反映决策来源", () => {
    const r = evaluatePolicy(input({ rules: [rule({ decision: "block" })] }));
    expect(r.reasonCodes.some((c) => c.startsWith("policy."))).toBe(true);
    expect(r.decisionSummary).toContain("已阻止");

    const allow = evaluatePolicy(input({ defaultDecision: "allow" }));
    expect(allow.reasonCodes).toContain("policy.default_allow");
    expect(allow.decisionSummary).toContain("已允许");
  });
});

describe("evaluatePolicy — argMatcher 与 scope（fail-closed）", () => {
  it("pathRegex 匹配 path（含规范化 ../）", () => {
    const r = evaluatePolicy(
      input({
        arguments: { path: "./src/../src/secret.txt" },
        rules: [rule({ decision: "block", argMatcher: { pathRegex: "^src/secret" } })],
      }),
    );
    expect(r.decision).toBe("block");
  });

  it("path 缺失时不匹配（fail-closed）", () => {
    const r = evaluatePolicy(
      input({
        arguments: {},
        rules: [rule({ decision: "block", argMatcher: { pathRegex: ".*" } })],
      }),
    );
    expect(r.decision).toBe("allow"); // 规则未命中 → default
  });

  it("commandRegex 匹配 command；缺失不匹配", () => {
    expect(
      evaluatePolicy(
        input({
          arguments: { command: "rm -rf /" },
          rules: [rule({ decision: "block", argMatcher: { commandRegex: "rm\\s+-rf" } })],
        }),
      ).decision,
    ).toBe("block");
    expect(
      evaluatePolicy(
        input({
          arguments: {},
          rules: [rule({ decision: "block", argMatcher: { commandRegex: ".*" } })],
        }),
      ).decision,
    ).toBe("allow");
  });

  it("超过长度上限的 path/command 不匹配（防 ReDoS）", () => {
    const longPath = "a".repeat(10_001);
    expect(
      evaluatePolicy(
        input({
          arguments: { path: longPath },
          rules: [rule({ decision: "block", argMatcher: { pathRegex: ".*" } })],
        }),
      ).decision,
    ).toBe("allow");
  });

  it("scope thread 精确匹配 ref；ref 为 null 时通配", () => {
    const threadRule = rule({ decision: "block", scope: { type: "thread", ref: "t1" } });
    expect(
      evaluatePolicy(input({ scopeContext: { threadId: "t1" }, rules: [threadRule] })).decision,
    ).toBe("block");
    expect(
      evaluatePolicy(input({ scopeContext: { threadId: "t2" }, rules: [threadRule] })).decision,
    ).toBe("allow");

    const wildcard = rule({ decision: "block", scope: { type: "thread", ref: null } });
    expect(
      evaluatePolicy(input({ scopeContext: { threadId: "any" }, rules: [wildcard] })).decision,
    ).toBe("block");
  });

  it("tenant / global scope 总是适用", () => {
    for (const type of ["tenant", "global"]) {
      expect(
        evaluatePolicy(input({ rules: [rule({ decision: "pause", scope: { type } })] })).decision,
      ).toBe("pause");
    }
  });

  it("未识别 scope 类型 fail-closed 不匹配", () => {
    const r = evaluatePolicy(
      input({ rules: [rule({ decision: "block", scope: { type: "unknown_scope" } })] }),
    );
    expect(r.decision).toBe("allow");
  });
});
