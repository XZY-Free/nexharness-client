import { describe, expect, it } from "vitest";
import {
  type ActivityEntry,
  activityKindFor,
  isRiskAction,
  mergeActionEntries,
  mergeThinkEntries,
  projectActivityEvent,
  projectAgentCallActivity,
  projectProgressItem,
} from "./activity-projection";
import type { ClientEvent } from "./types";

/**
 * activity 投影把执行过程转成员工可读的一行行记录。
 * 这些用例锁定：动作分类、风险标记、去重合并（同一操作只留一行）、状态终态不可被旧态覆盖。
 */
function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    key: "k1",
    turnId: "t1",
    kind: "exec",
    phase: "started",
    label: "x",
    block: null,
    risk: false,
    actionId: null,
    occurredAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function event(over: Partial<ClientEvent> = {}): ClientEvent {
  return {
    event_type: "harness.action.started",
    event_id: "e1",
    sequence: 1,
    schema_version: 1,
    thread_id: "t1",
    turn_id: "t1",
    item_id: null,
    occurred_at: "2026-01-01T00:00:00Z",
    payload: {},
    ...over,
  };
}

describe("activityKindFor / isRiskAction", () => {
  it("读类动作 → read", () => {
    expect(activityKindFor("read", null)).toBe("read");
    expect(activityKindFor("fetch_doc", null)).toBe("read");
  });

  it("搜索类 → search", () => {
    expect(activityKindFor("query", null)).toBe("search");
    expect(activityKindFor("search", null)).toBe("search");
    expect(activityKindFor("lookup", null)).toBe("search");
    expect(activityKindFor("list", null)).toBe("search");
  });

  it("写/危险类 → write", () => {
    for (const a of ["create", "write", "update", "delete", "send", "revoke", "approve"]) {
      expect(activityKindFor(a, null)).toBe("write");
    }
  });

  it("其它 → exec", () => {
    expect(activityKindFor("run", null)).toBe("exec");
    expect(activityKindFor("", null)).toBe("exec");
  });

  it("purposeCode 参与分类", () => {
    expect(activityKindFor("x", "search")).toBe("search");
  });

  it("isRiskAction 命中危险词", () => {
    expect(isRiskAction("delete", null)).toBe(true);
    expect(isRiskAction("read", null)).toBe(false);
    expect(isRiskAction("x", "approve")).toBe(true);
  });
});

describe("projectAgentCallActivity", () => {
  function call(over = {}) {
    return {
      call_id: "c1",
      display_name: "助手",
      state: "running",
      started_at: "2026-01-01T00:00:00Z",
      created_at: "2026-01-01T00:00:00Z",
      finished_at: null,
      waiting_at: null,
      duration_ms: null,
      ...over,
    };
  }

  it("每个 call 生成「请求 + 响应」两条记录", () => {
    const out = projectAgentCallActivity([call()] as never);
    expect(out.length).toBe(2);
    expect(out[0]?.key).toBe("agent-request-c1");
  });

  it("用户触发消息只进入请求记录的 block（不泄露内部参数）", () => {
    const out = projectAgentCallActivity([call()] as never, "帮我查一下");
    expect(out[0]?.block).toBe("你的请求：帮我查一下");
  });

  it("requestText 空白时 block 为 null", () => {
    expect(projectAgentCallActivity([call()] as never, "   ")[0]?.block).toBeNull();
    expect(projectAgentCallActivity([call()] as never, null)[0]?.block).toBeNull();
  });

  it("display_name 缺失时用「智能体」兜底", () => {
    const out = projectAgentCallActivity([call({ display_name: "" })] as never);
    expect(out[0]?.label).toContain("智能体");
  });

  it("queued 状态 → proposed / 「准备请求」", () => {
    const out = projectAgentCallActivity([call({ state: "queued" })] as never);
    expect(out[0]?.phase).toBe("proposed");
    expect(out[0]?.label).toContain("准备请求");
  });

  it("waiting_user → wait 类型", () => {
    const out = projectAgentCallActivity([call({ state: "waiting_user" })] as never);
    expect(out[1]?.kind).toBe("wait");
  });

  it("failed / lost → fail 类型", () => {
    expect(projectAgentCallActivity([call({ state: "failed" })] as never)[1]?.kind).toBe("fail");
    expect(projectAgentCallActivity([call({ state: "lost" })] as never)[1]?.kind).toBe("fail");
  });

  it("completed 带耗时节流（秒）且提供结果说明 block", () => {
    const out = projectAgentCallActivity([
      call({ state: "completed", duration_ms: 2500 }),
    ] as never);
    expect(out[1]?.label).toContain("3 秒");
    expect(out[1]?.block).toContain("平台整理");
  });

  it("duration_ms 为 null 时不显示耗时", () => {
    const out = projectAgentCallActivity([
      call({ state: "completed", duration_ms: null }),
    ] as never);
    expect(out[1]?.label).not.toContain("秒");
  });
});

describe("projectActivityEvent", () => {
  it("respond 动作不画成工具操作（正文由 assistant_message 展示）", () => {
    const r = projectActivityEvent(
      event({ payload: { action_type: "respond" }, event_type: "harness.action.started" }),
    );
    expect(r).toBeNull();
  });

  it("respond 失败事件仍投影（用于展示失败）", () => {
    const r = projectActivityEvent(
      event({ payload: { action_type: "respond" }, event_type: "harness.action.failed" }),
    );
    expect(r).not.toBeNull();
  });

  it("operationId=shell → exec kind", () => {
    const r = projectActivityEvent(
      event({ payload: { action_type: "act", action_payload: { operationId: "shell" } } }),
    );
    expect(r?.kind).toBe("exec");
  });

  it("web-fetch → read；web-search → search", () => {
    expect(
      projectActivityEvent(
        event({ payload: { action_type: "act", action_payload: { operationId: "web-fetch" } } }),
      )?.kind,
    ).toBeOneOf(["read", "exec"]);
  });

  it("危险 action_type 标记 risk=true", () => {
    const r = projectActivityEvent(event({ payload: { action_type: "delete" } }));
    expect(r?.risk).toBe(true);
  });

  it("缺少 action_type 兜底为 unknown 且不抛错", () => {
    expect(() => projectActivityEvent(event({ payload: {} }))).not.toThrow();
  });
});

describe("projectProgressItem", () => {
  it("kind=progress.snapshot 才投影，其余返回 null", () => {
    expect(projectProgressItem({ id: "i", turn_id: "t", content: { kind: "other" } })).toBeNull();
    expect(projectProgressItem({ id: "i", turn_id: "t", content: null })).toBeNull();
  });

  it("合法 progress 投影为 think 记录", () => {
    const r = projectProgressItem({
      id: "i1",
      turn_id: "t1",
      content: { kind: "progress.snapshot", message: "正在分析", think: "决定：先看文档" },
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(r?.kind).toBe("think");
    expect(r?.phase).toBe("think");
    expect(r?.label).toBe("正在分析");
    expect(r?.block).toBe("先看文档"); // 去掉「决定：」前缀
  });

  it("message 缺失时兜底「思考中…」", () => {
    const r = projectProgressItem({
      id: "i",
      turn_id: "t",
      content: { kind: "progress.snapshot" },
    });
    expect(r?.label).toBe("思考中…");
  });
});

describe("mergeActionEntries — 同一操作只留一行", () => {
  it("同 actionId+turnId 合并为一条，保留最早 key 与时间", () => {
    const out = mergeActionEntries([
      entry({ key: "first", actionId: "a1", phase: "started", occurredAt: "T0" }),
      entry({ key: "second", actionId: "a1", phase: "completed", occurredAt: "T1" }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.key).toBe("first");
    expect(out[0]?.phase).toBe("completed");
    expect(out[0]?.occurredAt).toBe("T0");
  });

  it("终态后到的非终态更新被忽略（防倒退）", () => {
    const out = mergeActionEntries([
      entry({ actionId: "a1", phase: "completed" }),
      entry({ actionId: "a1", phase: "started" }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.phase).toBe("completed");
  });

  it("不同 actionId 或不同 turnId 不合并", () => {
    const out = mergeActionEntries([
      entry({ actionId: "a1" }),
      entry({ actionId: "a2" }),
      entry({ actionId: "a1", turnId: "t2" }),
    ]);
    expect(out.length).toBe(3);
  });

  it("无 actionId 的条目独立保留", () => {
    const out = mergeActionEntries([entry({ actionId: null }), entry({ actionId: null })]);
    expect(out.length).toBe(2);
  });

  it("block 累积：新 block 含旧则替换，否则拼接", () => {
    const out = mergeActionEntries([
      entry({ actionId: "a1", block: "line1" }),
      entry({ actionId: "a1", block: "line1\nline2" }),
    ]);
    expect(out[0]?.block).toBe("line1\nline2");
  });
});

describe("mergeThinkEntries", () => {
  it("按 key 去重", () => {
    const out = mergeThinkEntries([
      entry({ key: "same", phase: "think" }),
      entry({ key: "same", phase: "think" }),
    ]);
    expect(out.length).toBe(1);
  });

  it("相邻同类 think（无 block、同 turn）合并保留最早 key", () => {
    const out = mergeThinkEntries([
      entry({ key: "k1", phase: "think", turnId: "t1", block: null }),
      entry({ key: "k2", phase: "think", turnId: "t1", block: null }),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]?.key).toBe("k1");
  });

  it("有 block 的 think 不合并", () => {
    const out = mergeThinkEntries([
      entry({ key: "k1", phase: "think", turnId: "t1", block: "b1" }),
      entry({ key: "k2", phase: "think", turnId: "t1", block: null }),
    ]);
    expect(out.length).toBe(2);
  });

  it("不同 turn 的 think 不合并", () => {
    const out = mergeThinkEntries([
      entry({ key: "k1", phase: "think", turnId: "t1" }),
      entry({ key: "k2", phase: "think", turnId: "t2" }),
    ]);
    expect(out.length).toBe(2);
  });
});
