import { describe, expect, it } from "vitest";
import {
  SENSITIVE_ACTION_KEYWORDS,
  classifyCommandRisk,
  containsSensitiveKeyword,
  decideApproval,
  requiresApproval,
  validateApprovalScope,
} from "./approval";

/**
 * 审批是「AI 不得擅自做危险操作」的闸门（Desktop 不盲信 Server）。
 * 这些用例锁定风险矩阵与 scope 校验——放宽必须改这里并说明理由。
 */
const NOW = 1_000_000;

describe("containsSensitiveKeyword", () => {
  it("命中中英文敏感动作词", () => {
    for (const d of ["删除记录", "Delete account", "提交表单", "Send email", "付款", "转账"]) {
      expect(containsSensitiveKeyword(d)).toBe(true);
    }
  });

  it("大小写不敏感", () => {
    expect(containsSensitiveKeyword("DELETE")).toBe(true);
    expect(containsSensitiveKeyword("SuBmIt")).toBe(true);
  });

  it("普通描述不误伤；空串返回 false", () => {
    expect(containsSensitiveKeyword("查看详情")).toBe(false);
    expect(containsSensitiveKeyword("next page")).toBe(false);
    expect(containsSensitiveKeyword("")).toBe(false);
  });
});

describe("classifyCommandRisk — 风险矩阵", () => {
  it("读取类命令 → read", () => {
    for (const c of ["browser.snapshot", "browser.getConsole", "browser.getNetwork"]) {
      expect(classifyCommandRisk(c, {})).toBe("read");
    }
  });

  it("导航类命令 → navigation", () => {
    for (const c of [
      "browser.navigate",
      "browser.reload",
      "browser.goBack",
      "browser.goForward",
      "browser.newTab",
      "browser.closeTab",
      "browser.switchTab",
    ]) {
      expect(classifyCommandRisk(c, {})).toBe("navigation");
    }
  });

  it("scroll 视为 read（不改变页面状态）", () => {
    expect(classifyCommandRisk("browser.scroll", {})).toBe("read");
  });

  it("click 依 description 判定；无敏感词视为 read", () => {
    expect(classifyCommandRisk("browser.click", { description: "查看详情" })).toBe("read");
    expect(classifyCommandRisk("browser.click", { description: "删除这条记录" })).toBe(
      "destructive",
    );
    expect(classifyCommandRisk("browser.click", { description: "提交订单" })).toBe(
      "external_write",
    );
    expect(classifyCommandRisk("browser.click", { description: "确认付款" })).toBe("financial");
  });

  it("type 指向密码框 → credential；否则 local_write", () => {
    expect(classifyCommandRisk("browser.type", { selector: "#password" })).toBe("credential");
    expect(classifyCommandRisk("browser.type", { selector: "input[name=pwd]" })).toBe("credential");
    expect(classifyCommandRisk("browser.type", { selector: "#username" })).toBe("local_write");
    expect(classifyCommandRisk("browser.type", {})).toBe("local_write");
  });

  it("press / select / uploadWorkspaceFile → local_write", () => {
    expect(classifyCommandRisk("browser.press", {})).toBe("local_write");
    expect(classifyCommandRisk("browser.select", {})).toBe("local_write");
    expect(classifyCommandRisk("browser.uploadWorkspaceFile", {})).toBe("local_write");
  });

  it("未知命令保守视为 external_write（需审批）", () => {
    expect(classifyCommandRisk("browser.hackThePlanet", {})).toBe("external_write");
    expect(classifyCommandRisk("", {})).toBe("external_write");
  });
});

describe("requiresApproval / decideApproval", () => {
  it("external_write / destructive / financial 需审批", () => {
    expect(requiresApproval("browser.click", { description: "提交" })).toBe(true);
    expect(requiresApproval("browser.click", { description: "删除" })).toBe(true);
    expect(requiresApproval("browser.click", { description: "付款" })).toBe(true);
    expect(decideApproval("browser.click", { description: "提交" })).toBe("require_approval");
  });

  it("read / navigation / local_write 直接放行", () => {
    expect(decideApproval("browser.snapshot", {})).toBe("allow");
    expect(decideApproval("browser.navigate", { url: "https://x" })).toBe("allow");
    expect(decideApproval("browser.press", {})).toBe("allow");
    expect(requiresApproval("browser.navigate", {})).toBe(false);
  });

  it("credential 一律 deny（AI 绝不代填密码）", () => {
    expect(decideApproval("browser.type", { selector: "#password" })).toBe("deny");
    // deny 不走审批流程：requiresApproval 为 false
    expect(requiresApproval("browser.type", { selector: "#password" })).toBe(false);
  });
});

describe("validateApprovalScope — 不盲信 Server", () => {
  const baseScope = {
    command: "browser.click",
    threadId: "t1",
    tabId: "tab1",
    url: "https://x/a",
    expiresAt: NOW + 60_000,
  };
  const basePayload = { threadId: "t1", tabId: "tab1", url: "https://x/a", description: "提交" };

  it("全字段匹配且未过期 → 通过", () => {
    expect(validateApprovalScope(baseScope, "browser.click", basePayload, NOW)).toEqual({
      ok: true,
    });
  });

  it("command 不匹配拒绝（防跨命令复用 approval）", () => {
    const r = validateApprovalScope(baseScope, "browser.navigate", basePayload, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("command_mismatch");
  });

  it("过期拒绝（expiresAt === now 视为过期）", () => {
    const r1 = validateApprovalScope(baseScope, "browser.click", basePayload, NOW + 60_000);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe("expired");
    const r2 = validateApprovalScope(baseScope, "browser.click", basePayload, NOW + 60_001);
    expect(r2.ok).toBe(false);
  });

  it("threadId 不匹配拒绝（防跨 thread 越权）", () => {
    const r = validateApprovalScope(
      baseScope,
      "browser.click",
      { ...basePayload, threadId: "t2" },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("thread_mismatch");
  });

  it("tabId 不匹配拒绝（双方都存在时）", () => {
    const r = validateApprovalScope(
      baseScope,
      "browser.click",
      { ...basePayload, tabId: "tab2" },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("tab_mismatch");
  });

  it("url 不匹配拒绝（防 navigate URL 被篡改）", () => {
    const r = validateApprovalScope(
      baseScope,
      "browser.click",
      { ...basePayload, url: "https://evil" },
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("url_mismatch");
  });

  it("payload 缺字段时跳过该项校验（非严格模式）", () => {
    // payload 无 tabId / url → 仅校验 command + expiresAt + threadId
    const r = validateApprovalScope(baseScope, "browser.click", { threadId: "t1" }, NOW);
    expect(r.ok).toBe(true);
  });

  it("scope 可选字段缺失时不误判（仅比对双方都有的字段）", () => {
    const scopeNoTab = { command: "browser.click", threadId: "t1", expiresAt: NOW + 1000 };
    const r = validateApprovalScope(
      scopeNoTab,
      "browser.click",
      { threadId: "t1", tabId: "x" },
      NOW,
    );
    expect(r.ok).toBe(true);
  });

  it("校验顺序：command 优先于 expired", () => {
    const r = validateApprovalScope(
      { ...baseScope, command: "other", expiresAt: NOW - 1 },
      "browser.click",
      basePayload,
      NOW,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("command_mismatch");
  });

  it("常量与映射一致：每个关键词都能被识别", () => {
    for (const k of SENSITIVE_ACTION_KEYWORDS) {
      expect(containsSensitiveKeyword(k)).toBe(true);
    }
  });
});
