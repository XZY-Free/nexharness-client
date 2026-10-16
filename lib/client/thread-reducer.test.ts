import { describe, expect, it } from "vitest";
import {
  MAX_APPLIED_EVENT_IDS,
  MAX_PENDING_TRANSIENT_PER_TURN,
  classifyTransientDelta,
  createInitialState,
  readTransientGeneration,
  threadProjectionReducer,
  transientItemId,
} from "./thread-reducer";
import type {
  ClientEvent,
  ClientGenerationBaseline,
  ClientItem,
  ClientTransientDelta,
} from "./types";

/**
 * thread-reducer 是前端会话投影的正确性核心：幂等（重复 SSE 不重复插入）、
 * 顺序（旧 sequence 不倒退、gap 触发 resnapshot）、代际隔离（旧代临时正文不串进新代）。
 */

const THREAD = "thread-1";

function item(over: Partial<ClientItem> = {}): ClientItem {
  return {
    id: "i1",
    turn_id: "turn-1",
    item_sequence: 1,
    item_type: "user_message",
    item_state: "completed",
    content: { text: "hi" },
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function event(over: Partial<ClientEvent> = {}): ClientEvent {
  return {
    event_type: "item.created",
    event_id: "e1",
    sequence: 1,
    schema_version: 1,
    thread_id: THREAD,
    turn_id: "turn-1",
    item_id: null,
    occurred_at: "2026-01-01T00:00:00Z",
    payload: { item: item() },
    ...over,
  };
}

function gen(over: Partial<ClientTransientDelta["generation"]> = {}) {
  return {
    invocation_id: "inv1",
    attempt_id: "att1",
    ownership_id: "own1",
    lease_epoch: "1",
    ...over,
  };
}

function delta(over: Partial<ClientTransientDelta> = {}): ClientTransientDelta {
  return {
    transient_id: "tr1",
    thread_id: THREAD,
    turn_id: "turn-1",
    generation: gen(),
    occurred_at: "2026-01-01T00:00:00Z",
    delta: "Hello",
    ...over,
  };
}

function baseline(over: Partial<ClientGenerationBaseline> = {}): ClientGenerationBaseline {
  return {
    thread_id: THREAD,
    baseline_sequence: 1,
    issued_revision: 1,
    generations: [{ turn_id: "turn-1", generation: gen() }],
    ...over,
  };
}

describe("createInitialState", () => {
  it("初始状态各字段为空/default", () => {
    const s = createInitialState(THREAD);
    expect(s.threadId).toBe(THREAD);
    expect(s.items).toEqual([]);
    expect(s.itemsById).toEqual({});
    expect(s.lastAppliedEventSequence).toBe(0);
    expect(s.appliedEventIds.size).toBe(0);
    expect(s.generationBaseline).toBeNull();
    expect(s.pendingTransients).toEqual({});
    expect(s.streamStatus).toBe("idle");
    expect(s.snapshotStatus).toBe("idle");
  });
});

describe("snapshot.loaded", () => {
  it("替换 items、按 item_sequence 排序、重置游标与 appliedEventIds", () => {
    const s = threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [item({ id: "b", item_sequence: 2 }), item({ id: "a", item_sequence: 1 })],
      latestEventCursor: { sequence: 5, event_id: "ev5" },
    });
    expect(s.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(s.lastAppliedEventSequence).toBe(5);
    expect(s.appliedEventIds.has("ev5")).toBe(true);
    expect(s.snapshotStatus).toBe("ready");
    expect(s.activity).toEqual([]);
    expect(s.hasAppliedEventSinceSnapshot).toBe(false);
  });

  it("保留投影等价的旧 item 引用（避免整体重绘）", () => {
    // isItemEqual 用 content 引用相等判定；共享同一 content 对象模拟「投影等价」
    const sharedContent = { text: "hi" };
    const kept = item({ id: "a", item_sequence: 1, content: sharedContent });
    const prev = threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [kept],
      latestEventCursor: null,
    });
    const next = threadProjectionReducer(prev, {
      type: "snapshot.loaded",
      items: [item({ id: "a", item_sequence: 1, content: sharedContent })], // 同 content 引用的新 item 对象
      latestEventCursor: null,
    });
    expect(next.items[0]).toBe(kept); // 保持同一引用
  });

  it("content 引用变化时用新 item（投影不等价则不保留旧引用）", () => {
    const prev = threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [item({ id: "a", item_sequence: 1, content: { text: "old" } })],
      latestEventCursor: null,
    });
    const next = threadProjectionReducer(prev, {
      type: "snapshot.loaded",
      items: [item({ id: "a", item_sequence: 1, content: { text: "new" } })],
      latestEventCursor: null,
    });
    expect((next.items[0]?.content as { text: string }).text).toBe("new");
  });

  it("cursor 为 null 时游标归零、appliedEventIds 清空", () => {
    const s = threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [],
      latestEventCursor: null,
    });
    expect(s.lastAppliedEventSequence).toBe(0);
    expect(s.appliedEventIds.size).toBe(0);
  });
});

describe("event.received — 幂等与顺序", () => {
  const loaded = threadProjectionReducer(createInitialState(THREAD), {
    type: "snapshot.loaded",
    items: [],
    latestEventCursor: { sequence: 0, event_id: null },
  });

  it("重复 event_id 不重复插入（跨重连/重复 SSE）", () => {
    const s1 = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({ event_id: "dup", sequence: 1 }),
    });
    const s2 = threadProjectionReducer(s1, {
      type: "event.received",
      event: event({ event_id: "dup", sequence: 2 }),
    });
    expect(s2).toBe(s1); // 引用不变
    expect(s2.items.length).toBe(1);
  });

  it("旧 sequence 直接丢弃（严格单调防倒退）", () => {
    const s1 = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({ event_id: "e2", sequence: 2 }),
    });
    const s2 = threadProjectionReducer(s1, {
      type: "event.received",
      event: event({ event_id: "e1", sequence: 1 }),
    });
    expect(s2).toBe(s1);
  });

  it("snapshot 后第一条允许不连续（服务端补发）", () => {
    const s = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({ event_id: "e9", sequence: 9 }),
    });
    expect(s.visibleError).toBeNull();
    expect(s.lastAppliedEventSequence).toBe(9);
  });

  it("之后 sequence 不连续（gap）→ resnapshot + EVENT_SEQUENCE_GAP", () => {
    const s1 = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({ event_id: "e1", sequence: 1 }),
    });
    const s2 = threadProjectionReducer(s1, {
      type: "event.received",
      event: event({ event_id: "e5", sequence: 5 }),
    });
    expect(s2.streamStatus).toBe("resnapshot");
    expect(s2.visibleError?.code).toBe("EVENT_SEQUENCE_GAP");
    expect(s2.visibleError?.retryable).toBe(true);
  });

  it("连续 sequence 正常应用", () => {
    const s1 = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({ event_id: "e1", sequence: 1 }),
    });
    const s2 = threadProjectionReducer(s1, {
      type: "event.received",
      event: event({
        event_id: "e2",
        sequence: 2,
        payload: { item: item({ id: "i2", item_sequence: 2 }) },
      }),
    });
    expect(s2.visibleError).toBeNull();
    expect(s2.lastAppliedEventSequence).toBe(2);
    expect(s2.items.length).toBe(2);
  });

  it("stream.resumed 事件只更新状态、不进投影", () => {
    const s = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({ event_type: "stream.resumed", event_id: "r1", sequence: 3 }),
    });
    expect(s).toBe(loaded);
  });
});

describe("item.created / item.updated 投影", () => {
  const loaded = threadProjectionReducer(createInitialState(THREAD), {
    type: "snapshot.loaded",
    items: [],
    latestEventCursor: { sequence: 0, event_id: null },
  });

  it("item_id 已存在则替换（不重复）", () => {
    const s1 = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({ event_id: "e1", sequence: 1 }),
    });
    const s2 = threadProjectionReducer(s1, {
      type: "event.received",
      event: event({
        event_id: "e2",
        sequence: 2,
        payload: { item: item({ id: "i1", content: { text: "updated" } }) },
      }),
    });
    expect(s2.items.length).toBe(1);
    expect((s2.items[0]?.content as { text: string }).text).toBe("updated");
  });

  it("按 item_sequence 插入到正确位置（保持升序）", () => {
    const s1 = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({
        event_id: "e1",
        sequence: 1,
        payload: { item: item({ id: "a", item_sequence: 1 }) },
      }),
    });
    const s2 = threadProjectionReducer(s1, {
      type: "event.received",
      event: event({
        event_id: "e2",
        sequence: 2,
        payload: { item: item({ id: "c", item_sequence: 3 }) },
      }),
    });
    const s3 = threadProjectionReducer(s2, {
      type: "event.received",
      event: event({
        event_id: "e3",
        sequence: 3,
        payload: { item: item({ id: "b", item_sequence: 2 }) },
      }),
    });
    expect(s3.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("payload 结构不合法（缺字段）时事件被忽略", () => {
    const s = threadProjectionReducer(loaded, {
      type: "event.received",
      event: event({ event_id: "bad", sequence: 1, payload: { item: { id: "x" } } }),
    });
    expect(s.items).toEqual([]);
    expect(s.lastAppliedEventSequence).toBe(1); // 游标仍推进
  });

  it("正式 assistant_message 成立 → 该 turn 的所有临时正文退出", () => {
    const withTransient = threadProjectionReducer(loaded, {
      type: "stream.delta",
      event: delta(),
    });
    // 先给基线使其 apply
    const s0 = threadProjectionReducer(withTransient, {
      type: "stream.generation",
      baseline: baseline(),
    });
    const s = threadProjectionReducer(s0, {
      type: "event.received",
      event: event({
        event_id: "done",
        sequence: 1,
        payload: {
          item: item({
            id: "final",
            item_type: "assistant_message",
            item_state: "completed",
            item_sequence: 5,
          }),
        },
      }),
    });
    expect(s.items.some((i) => readTransientGeneration(i) !== null)).toBe(false);
    expect(s.items.some((i) => i.id === "final")).toBe(true);
  });
});

describe("item.superseded", () => {
  it("标记 item 为 superseded 但保留（可追溯）", () => {
    const s1 = threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [item({ id: "a" })],
      latestEventCursor: { sequence: 0, event_id: null },
    });
    const s2 = threadProjectionReducer(s1, {
      type: "event.received",
      event: event({
        event_type: "item.superseded",
        event_id: "sup",
        sequence: 1,
        item_id: "a",
        payload: { superseded_by_item_id: "b" },
      }),
    });
    expect(s2.items.length).toBe(1);
    expect(s2.items[0]?.item_state).toBe("superseded");
    expect((s2.items[0]?.content as { superseded_by_item_id: string }).superseded_by_item_id).toBe(
      "b",
    );
  });
});

describe("user_action.resolved", () => {
  function seedUserAction() {
    return threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [
        item({
          id: "ua",
          item_type: "user_action",
          item_state: "pending",
          content: { request_id: "req-1" },
        }),
      ],
      latestEventCursor: { sequence: 0, event_id: null },
    });
  }

  it("合法 resolution 把 user_action 标为 completed", () => {
    const s = threadProjectionReducer(seedUserAction(), {
      type: "event.received",
      event: event({
        event_type: "user_action.resolved",
        event_id: "r1",
        sequence: 1,
        item_id: "ua",
        payload: { request_id: "req-1", resolution: "approve" },
      }),
    });
    expect(s.items[0]?.item_state).toBe("completed");
    expect((s.items[0]?.content as { resolution: string }).resolution).toBe("approve");
  });

  it("request_id 不匹配时忽略（防错配动作）", () => {
    const s = threadProjectionReducer(seedUserAction(), {
      type: "event.received",
      event: event({
        event_type: "user_action.resolved",
        event_id: "r1",
        sequence: 1,
        item_id: "ua",
        payload: { request_id: "wrong", resolution: "approve" },
      }),
    });
    expect(s.items[0]?.item_state).toBe("pending");
  });

  it("非法 resolution 忽略", () => {
    const s = threadProjectionReducer(seedUserAction(), {
      type: "event.received",
      event: event({
        event_type: "user_action.resolved",
        event_id: "r1",
        sequence: 1,
        item_id: "ua",
        payload: { request_id: "req-1", resolution: "hack" },
      }),
    });
    expect(s.items[0]?.item_state).toBe("pending");
  });
});

describe("classifyTransientDelta — 决策表", () => {
  it("无基线 → stage（有界暂存，不拼旧正文）", () => {
    expect(classifyTransientDelta(null, delta())).toBe("stage");
  });

  it("基线未覆盖该 turn → stage", () => {
    expect(classifyTransientDelta(baseline({ generations: [] }), delta())).toBe("stage");
  });

  it("基线明确该 turn 无活动执行（generation=null）→ drop", () => {
    expect(
      classifyTransientDelta(
        baseline({ generations: [{ turn_id: "turn-1", generation: null }] }),
        delta(),
      ),
    ).toBe("drop");
  });

  it("与权威 tuple 完全相同 → apply", () => {
    expect(classifyTransientDelta(baseline(), delta())).toBe("apply");
  });

  it("同 invocation 同 epoch 但换 ownership → conflict", () => {
    const incoming = delta({ generation: gen({ ownership_id: "other" }) });
    expect(classifyTransientDelta(baseline(), incoming)).toBe("conflict");
  });

  it("同 invocation 旧 epoch → drop（迟到重放）", () => {
    const b = baseline({
      generations: [{ turn_id: "turn-1", generation: gen({ lease_epoch: "5" }) }],
    });
    const incoming = delta({ generation: gen({ lease_epoch: "3" }) });
    expect(classifyTransientDelta(b, incoming)).toBe("drop");
  });

  it("同 turn 不同 invocation → drop（不比较 epoch 大小）", () => {
    const b = baseline({
      generations: [
        { turn_id: "turn-1", generation: gen({ invocation_id: "invA", lease_epoch: "1" }) },
      ],
    });
    const incoming = delta({ generation: gen({ invocation_id: "invB", lease_epoch: "99" }) });
    expect(classifyTransientDelta(b, incoming)).toBe("drop");
  });
});

describe("stream.delta — 代际隔离", () => {
  it("无基线时暂存（pendingTransients），不直接进 items", () => {
    const s = threadProjectionReducer(createInitialState(THREAD), {
      type: "stream.delta",
      event: delta(),
    });
    expect(s.items).toEqual([]);
    expect(s.pendingTransients["turn-1"]?.length).toBe(1);
  });

  it("暂存有界：超过上限丢最旧", () => {
    let s = createInitialState(THREAD);
    for (let i = 0; i < MAX_PENDING_TRANSIENT_PER_TURN + 5; i++) {
      s = threadProjectionReducer(s, {
        type: "stream.delta",
        event: delta({ transient_id: `tr${i}` }),
      });
    }
    const staged = s.pendingTransients["turn-1"] ?? [];
    expect(staged.length).toBe(MAX_PENDING_TRANSIENT_PER_TURN);
    expect(staged[staged.length - 1]?.transient_id).toBe(`tr${MAX_PENDING_TRANSIENT_PER_TURN + 4}`);
  });

  it("基线到达后同代暂存 delta 被 apply 并拼接", () => {
    let s = createInitialState(THREAD);
    s = threadProjectionReducer(s, {
      type: "stream.delta",
      event: delta({ transient_id: "t1", delta: "Hello " }),
    });
    s = threadProjectionReducer(s, {
      type: "stream.delta",
      event: delta({ transient_id: "t2", delta: "world" }),
    });
    s = threadProjectionReducer(s, { type: "stream.generation", baseline: baseline() });
    expect(s.pendingTransients["turn-1"]).toBeUndefined();
    const transientItem = s.items.find((i) => readTransientGeneration(i) !== null);
    expect((transientItem?.content as { text: string }).text).toBe("Hello world");
  });

  it("同代 apply 后重复 transient_id 幂等（不重复拼接）", () => {
    let s = threadProjectionReducer(createInitialState(THREAD), {
      type: "stream.generation",
      baseline: baseline(),
    });
    s = threadProjectionReducer(s, {
      type: "stream.delta",
      event: delta({ transient_id: "same", delta: "A" }),
    });
    const before = s.items.length;
    s = threadProjectionReducer(s, {
      type: "stream.delta",
      event: delta({ transient_id: "same", delta: "A" }),
    });
    expect(s.items.length).toBe(before);
    expect(
      (s.items.find((i) => readTransientGeneration(i) !== null)?.content as { text: string }).text,
    ).toBe("A");
  });

  it("不同 thread 的 delta 被忽略", () => {
    const s = threadProjectionReducer(createInitialState(THREAD), {
      type: "stream.delta",
      event: delta({ thread_id: "other-thread" }),
    });
    expect(s.pendingTransients).toEqual({});
    expect(s.items).toEqual([]);
  });

  it("已存在正式回复时不再拼接临时正文", () => {
    let s = threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [item({ id: "final", item_type: "assistant_message", item_state: "completed" })],
      latestEventCursor: null,
    });
    s = threadProjectionReducer(s, { type: "stream.generation", baseline: baseline() });
    s = threadProjectionReducer(s, { type: "stream.delta", event: delta() });
    expect(s.items.some((i) => readTransientGeneration(i) !== null)).toBe(false);
  });
});

describe("stream.generation — 换代隔离", () => {
  it("旧代临时正文随权威换代移除", () => {
    let s = threadProjectionReducer(createInitialState(THREAD), {
      type: "stream.generation",
      baseline: baseline(),
    });
    s = threadProjectionReducer(s, {
      type: "stream.delta",
      event: delta({ transient_id: "old", delta: "old text" }),
    });
    expect(s.items.some((i) => readTransientGeneration(i) !== null)).toBe(true);

    // 换代：新 invocation
    const newBaseline = baseline({
      baseline_sequence: 2,
      issued_revision: 2,
      generations: [
        { turn_id: "turn-1", generation: gen({ invocation_id: "inv2", lease_epoch: "1" }) },
      ],
    });
    s = threadProjectionReducer(s, { type: "stream.generation", baseline: newBaseline });
    expect(s.items.some((i) => readTransientGeneration(i) !== null)).toBe(false);
  });

  it("迟到的旧基线不采用（issued_revision 不增）", () => {
    const s1 = threadProjectionReducer(createInitialState(THREAD), {
      type: "stream.generation",
      baseline: baseline({ issued_revision: 5, baseline_sequence: 5 }),
    });
    const s2 = threadProjectionReducer(s1, {
      type: "stream.generation",
      baseline: baseline({ issued_revision: 3, baseline_sequence: 3 }),
    });
    expect(s2).toBe(s1);
  });

  it("正式 Item 永远不会被换代清理", () => {
    let s = threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [item({ id: "official" })],
      latestEventCursor: null,
    });
    s = threadProjectionReducer(s, {
      type: "stream.generation",
      baseline: baseline({ issued_revision: 9, baseline_sequence: 9 }),
    });
    expect(s.items.some((i) => i.id === "official")).toBe(true);
  });
});

describe("stream.generation_reset / status / cursor_expired / failed", () => {
  it("generation_reset 清基线；已为空时返回原 state", () => {
    const empty = createInitialState(THREAD);
    expect(threadProjectionReducer(empty, { type: "stream.generation_reset" })).toBe(empty);

    const withBaseline = threadProjectionReducer(empty, {
      type: "stream.generation",
      baseline: baseline(),
    });
    const reset = threadProjectionReducer(withBaseline, { type: "stream.generation_reset" });
    expect(reset.generationBaseline).toBeNull();
    expect(reset.pendingTransients).toEqual({});
  });

  it("stream.status：reconnecting 累加计数，open 清零", () => {
    let s = createInitialState(THREAD);
    s = threadProjectionReducer(s, {
      type: "stream.status",
      status: "reconnecting",
      reconnectAttempt: 2,
    });
    expect(s.streamStatus).toBe("reconnecting");
    expect(s.reconnectAttempt).toBe(2);
    s = threadProjectionReducer(s, { type: "stream.status", status: "open" });
    expect(s.reconnectAttempt).toBe(0);
  });

  it("cursor_expired → resnapshot + 错误", () => {
    const err = {
      code: "EVENT_CURSOR_EXPIRED",
      title: "t",
      description: "d",
      retryable: true,
      recoveryAction: "resnapshot" as const,
      requestId: null,
    };
    const s = threadProjectionReducer(createInitialState(THREAD), {
      type: "stream.cursor_expired",
      error: err,
    });
    expect(s.streamStatus).toBe("resnapshot");
    expect(s.visibleError?.code).toBe("EVENT_CURSOR_EXPIRED");
  });

  it("stream.failed → failed + 错误", () => {
    const err = {
      code: "STREAM_FAILED",
      title: "t",
      description: "d",
      retryable: false,
      recoveryAction: "none" as const,
      requestId: "req",
    };
    const s = threadProjectionReducer(createInitialState(THREAD), {
      type: "stream.failed",
      error: err,
    });
    expect(s.streamStatus).toBe("failed");
    expect(s.visibleError?.code).toBe("STREAM_FAILED");
  });

  it("snapshot.loading 已有 items 时不显示全屏 spinner（保持 ready）", () => {
    const withItems = threadProjectionReducer(createInitialState(THREAD), {
      type: "snapshot.loaded",
      items: [item()],
      latestEventCursor: null,
    });
    const loading = threadProjectionReducer(withItems, { type: "snapshot.loading" });
    expect(loading.snapshotStatus).toBe("ready");
  });

  it("未知 action 返回原 state", () => {
    const s = createInitialState(THREAD);
    expect(threadProjectionReducer(s, { type: "nonexistent" as never })).toBe(s);
  });
});

describe("transientItemId / readTransientGeneration", () => {
  it("id 含完整代际 tuple（同 turn 不同代不碰撞）", () => {
    const id1 = transientItemId("turn-1", gen({ invocation_id: "invA" }));
    const id2 = transientItemId("turn-1", gen({ invocation_id: "invB" }));
    expect(id1).not.toBe(id2);
    expect(id1.startsWith("stream-")).toBe(true);
  });

  it("readTransientGeneration 往返一致", () => {
    const g = gen();
    const it = item({ id: transientItemId("turn-1", g), content: { text: "x", generation: g } });
    expect(readTransientGeneration(it)).toEqual(g);
  });

  it("非临时 Item / 结构不合法返回 null", () => {
    expect(readTransientGeneration(item({ id: "official" }))).toBeNull();
    expect(readTransientGeneration(item({ id: "stream-x", content: { noGen: 1 } }))).toBeNull();
    expect(readTransientGeneration(item({ id: "stream-x", content: null }))).toBeNull();
  });
});

/**
 * appliedEventIds 有界化。去重集原先只增不减（仅 snapshot 重置）。
 * 正确性依赖：被淘汰的 event_id 其 sequence 早已低于游标，重复到达会被
 * sequence 单调闸门挡掉——因此有界窗口不影响幂等语义。
 */
describe("appliedEventIds — 有界去重窗口", () => {
  it("去重集大小被限制在 MAX_APPLIED_EVENT_IDS 内", () => {
    let state = createInitialState(THREAD);
    // 逐条应用，绕过 gap 检查：snapshot 后第一条不限连续，之后必须连续；
    // 这里显式保持 sequence 连续递增。
    const total = MAX_APPLIED_EVENT_IDS + 50;
    for (let i = 1; i <= total; i++) {
      state = threadProjectionReducer(state, {
        type: "event.received",
        event: event({ event_id: `e${i}`, sequence: i, item_id: `i${i}` }),
      });
    }
    expect(state.appliedEventIds.size).toBeLessThanOrEqual(MAX_APPLIED_EVENT_IDS);
    // 游标仍正确推进（有界化不得影响顺序状态）
    expect(state.lastAppliedEventSequence).toBe(total);
  });

  it("窗口内重复 event_id 仍被去重", () => {
    let state = createInitialState(THREAD);
    state = threadProjectionReducer(state, {
      type: "event.received",
      event: event({ event_id: "dup", sequence: 1, item_id: "a" }),
    });
    const before = state;
    const after = threadProjectionReducer(before, {
      type: "event.received",
      event: event({ event_id: "dup", sequence: 1, item_id: "a" }),
    });
    // 命中去重 → 原 state 返回
    expect(after).toBe(before);
  });

  it("被淘汰的旧 event_id 重复到达仍被 sequence 闸门拦下（不重复插入）", () => {
    let state = createInitialState(THREAD);
    const total = MAX_APPLIED_EVENT_IDS + 50;
    for (let i = 1; i <= total; i++) {
      state = threadProjectionReducer(state, {
        type: "event.received",
        event: event({ event_id: `e${i}`, sequence: i, item_id: `i${i}` }),
      });
    }
    const itemsBefore = state.items.length;
    // "e1" 早已被挤出窗口，但 sequence=1 <= 游标 → 丢弃
    const after = threadProjectionReducer(state, {
      type: "event.received",
      event: event({ event_id: "e1", sequence: 1, item_id: "i1" }),
    });
    expect(after).toBe(state);
    expect(after.items.length).toBe(itemsBefore);
  });
});

/**
 * 热路径优化后的不变量：临时正文追加必须保持 items 按 item_sequence 升序，
 * 且已存在时只替换不重排（这是把二分插入换成「替换 + 追加」的正确性前提）。
 */
describe("applyTransientDelta 路径优化 — 顺序不变量", () => {
  const baseline: ClientGenerationBaseline = {
    thread_id: THREAD,
    baseline_sequence: 10,
    issued_revision: 1,
    generations: [{ turn_id: "turn-1", generation: gen() }],
  };

  function delta(over: Partial<ClientTransientDelta> = {}): ClientTransientDelta {
    return {
      transient_id: "d1",
      thread_id: THREAD,
      turn_id: "turn-1",
      generation: gen(),
      occurred_at: "2026-01-01T00:00:00Z",
      delta: "字",
      ...over,
    };
  }

  function stateWithBaseline() {
    return threadProjectionReducer(createInitialState(THREAD), {
      type: "stream.generation",
      baseline,
    });
  }

  it("多次追加后 items 仍按 item_sequence 严格升序", () => {
    let state = stateWithBaseline();
    for (let i = 0; i < 20; i++) {
      state = threadProjectionReducer(state, {
        type: "stream.delta",
        event: delta({ transient_id: `d${i}`, delta: `${i}` }),
      });
    }
    const seqs = state.items.map((it) => it.item_sequence);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
    // 临时正文只有一条（同代际 tuple），且文本按到达顺序拼接
    expect(state.items.length).toBe(1);
    expect((state.items[0]?.content as { text: string }).text).toBe(
      Array.from({ length: 20 }, (_, i) => i).join(""),
    );
  });

  it("追加时新 item_sequence 为当前最大值 +1", () => {
    let state = stateWithBaseline();
    state = threadProjectionReducer(state, {
      type: "stream.delta",
      event: delta({ transient_id: "a", delta: "a" }),
    });
    const firstSeq = state.items[0]?.item_sequence;
    // 同 tuple 再追加不产生新条（仍一条），顺序稳定
    state = threadProjectionReducer(state, {
      type: "stream.delta",
      event: delta({ transient_id: "b", delta: "b" }),
    });
    expect(state.items.length).toBe(1);
    expect(state.items[0]?.item_sequence).toBe(firstSeq);
  });

  it("重复 transient_id 幂等（不重复拼接、不改变数组）", () => {
    let state = stateWithBaseline();
    state = threadProjectionReducer(state, {
      type: "stream.delta",
      event: delta({ transient_id: "dup", delta: "X" }),
    });
    const before = state;
    state = threadProjectionReducer(state, {
      type: "stream.delta",
      event: delta({ transient_id: "dup", delta: "X" }),
    });
    expect(state).toBe(before);
    expect((state.items[0]?.content as { text: string }).text).toBe("X");
  });

  it("itemsById 随每次追加保持同步（O(1) 定位的前提）", () => {
    let state = stateWithBaseline();
    for (let i = 0; i < 5; i++) {
      state = threadProjectionReducer(state, {
        type: "stream.delta",
        event: delta({ transient_id: `t${i}`, delta: `${i}` }),
      });
      for (const item of state.items) {
        expect(state.itemsById[item.id]).toBe(item);
      }
    }
  });
});
