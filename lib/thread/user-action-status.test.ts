import { describe, expect, it } from "vitest";
import type { UserActionContent } from "./user-action-fields";
import {
  deriveStatusPresentation,
  deriveUserActionStatus,
  resolveResolvedResolution,
} from "./user-action-status";

/**
 * UserAction 状态派生是安全相关规则（fail-closed）。
 * 这些用例锁定：requestId 不 fallback、超时禁操作、解析结果只按 Authority id 匹配。
 */
const NOW = 1_700_000_000_000;
const pending = { item_state: "pending" };
const completed = { item_state: "completed" };

describe("deriveUserActionStatus — requestId（fail-closed）", () => {
  it("非空 request_id → trim 后采用", () => {
    const s = deriveUserActionStatus({ request_id: "  req-1  " }, pending, NOW);
    expect(s.requestId).toBe("req-1");
  });

  it("缺失 / 空串 / 纯空白 → null（**绝不 fallback 到 item.id**）", () => {
    expect(deriveUserActionStatus({}, pending, NOW).requestId).toBeNull();
    expect(deriveUserActionStatus({ request_id: "" }, pending, NOW).requestId).toBeNull();
    expect(deriveUserActionStatus({ request_id: "   " }, pending, NOW).requestId).toBeNull();
    expect(deriveUserActionStatus({ request_id: 123 as never }, pending, NOW).requestId).toBeNull();
  });
});

describe("deriveUserActionStatus — 超时", () => {
  it("content.state=expired → 超时", () => {
    expect(deriveUserActionStatus({ state: "expired" }, pending, NOW).isExpired).toBe(true);
  });

  it("expires_at 早于 now → 超时", () => {
    const past = new Date(NOW - 1000).toISOString();
    expect(deriveUserActionStatus({ expires_at: past }, pending, NOW).isExpired).toBe(true);
  });

  it("expires_at 晚于 now → 未超时", () => {
    const future = new Date(NOW + 60_000).toISOString();
    expect(deriveUserActionStatus({ expires_at: future }, pending, NOW).isExpired).toBe(false);
  });

  it("超时一律不展示操作按钮（即便 content.state 缺失且 item 仍 pending）", () => {
    const past = new Date(NOW - 1000).toISOString();
    // item 仍是 pending、content.state 缺失 → 单看这两项会认为是待处理，
    // 但 expires_at 已过 → showActions 必须为 false（超时优先，fail-closed）
    const s = deriveUserActionStatus({ expires_at: past }, pending, NOW);
    expect(s.isExpired).toBe(true);
    expect(s.isRequestPending).toBe(true);
    expect(s.showActions).toBe(false);
  });

  it("content.state=expired 时即便 item pending 也不展示操作", () => {
    const s = deriveUserActionStatus({ state: "expired" }, pending, NOW);
    expect(s.showActions).toBe(false);
  });
});

describe("deriveUserActionStatus — pending / resolved 判定", () => {
  it("content.state=pending → 待处理", () => {
    const s = deriveUserActionStatus({ state: "pending" }, completed, NOW);
    expect(s.isRequestPending).toBe(true);
    expect(s.isResolved).toBe(false);
    expect(s.showActions).toBe(true);
  });

  it("content.state 缺失 + item pending → 待处理", () => {
    expect(deriveUserActionStatus({}, pending, NOW).isRequestPending).toBe(true);
  });

  it("content.state 缺失 + item completed → 不 pending 且视为已解析", () => {
    const s = deriveUserActionStatus({}, completed, NOW);
    expect(s.isRequestPending).toBe(false);
    expect(s.isResolved).toBe(true);
    expect(s.showActions).toBe(false);
  });

  it("content.state=resolved → 已解析", () => {
    const s = deriveUserActionStatus({ state: "resolved" }, completed, NOW);
    expect(s.isResolved).toBe(true);
    expect(s.showActions).toBe(false);
  });
});

describe("resolveResolvedResolution — 只按 Authority id 匹配", () => {
  it("lastResolve 的 request_id 与 Authority id 一致 → 采用", () => {
    const content: UserActionContent = { request_id: "req-1", state: "pending" };
    const status = deriveUserActionStatus(content, pending, NOW);
    expect(
      resolveResolvedResolution(content, status, { request_id: "req-1", resolution: "approve" }),
    ).toBe("approve");
  });

  it("request_id 不一致 → 不采用 lastResolve", () => {
    const content: UserActionContent = { request_id: "req-1", state: "pending" };
    const status = deriveUserActionStatus(content, pending, NOW);
    expect(
      resolveResolvedResolution(content, status, { request_id: "req-2", resolution: "deny" }),
    ).toBeNull();
  });

  it("无 Authority id 时**不**回退到 item.id（保持 null）", () => {
    const content: UserActionContent = { state: "pending" };
    const status = deriveUserActionStatus(content, pending, NOW);
    expect(
      resolveResolvedResolution(content, status, { request_id: "whatever", resolution: "approve" }),
    ).toBeNull();
  });

  it("content.state=resolved 时采用 content.resolution", () => {
    const content: UserActionContent = { state: "resolved", resolution: "submit" };
    const status = deriveUserActionStatus(content, completed, NOW);
    expect(resolveResolvedResolution(content, status, null)).toBe("submit");
  });
});

describe("deriveStatusPresentation — 标签与配色", () => {
  it("超时 → 已超时 + destructive 配色", () => {
    const content: UserActionContent = { state: "expired" };
    const status = deriveUserActionStatus(content, pending, NOW);
    const p = deriveStatusPresentation(content, pending, status, null);
    expect(p.label).toBe("已超时");
    expect(p.tagClass).toContain("destructive");
  });

  it("已解析 → 中文解析文案 + success 配色", () => {
    const content: UserActionContent = { state: "resolved" };
    const status = deriveUserActionStatus(content, completed, NOW);
    const p = deriveStatusPresentation(content, completed, status, "approve");
    expect(p.label).toBe("已同意");
    expect(p.tagClass).toContain("success");
  });

  it("待处理按 request_type 区分文案", () => {
    for (const [rt, label] of [
      ["input", "需要你的输入"],
      ["auth", "需要你授权"],
      ["confirmation", "需要你的确认"],
      [undefined, "需要你的确认"],
    ] as const) {
      const content: UserActionContent = { state: "pending", request_type: rt };
      const status = deriveUserActionStatus(content, pending, NOW);
      expect(deriveStatusPresentation(content, pending, status, null).label).toBe(label);
    }
  });

  it("已完成 / 失败 / 等待处理", () => {
    const c1: UserActionContent = {};
    const c2: UserActionContent = {};
    const s1 = deriveUserActionStatus(c1, { item_state: "completed" }, NOW);
    const s2 = deriveUserActionStatus(c2, { item_state: "failed" }, NOW);
    expect(deriveStatusPresentation(c1, { item_state: "completed" }, s1, null).label).toBe(
      "已完成",
    );
    expect(deriveStatusPresentation(c2, { item_state: "failed" }, s2, null).label).toBe("失败");
    const c3: UserActionContent = {};
    const s3 = deriveUserActionStatus(c3, { item_state: "cancelled" }, NOW);
    expect(deriveStatusPresentation(c3, { item_state: "cancelled" }, s3, null).label).toBe(
      "等待处理",
    );
  });
});
