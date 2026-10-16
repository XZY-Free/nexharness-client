import { describe, expect, it } from "vitest";
import { parseGenerationBaseline, parseTransientGeneration } from "./sse-client";

/**
 * SSE 线上负载解析是「畸形数据不得进入投影」的入口（fail-closed）。
 * 这些用例锁定：字段严格校验、epoch 十进制约束、generation=null 与缺字段语义不同。
 */
describe("parseTransientGeneration", () => {
  const valid = {
    invocation_id: "inv1",
    attempt_id: "att1",
    ownership_id: "own1",
    lease_epoch: "1",
  };

  it("合法对象解析成功", () => {
    expect(parseTransientGeneration(valid)).toEqual(valid);
  });

  it("非对象 / null 返回 null", () => {
    expect(parseTransientGeneration(null)).toBeNull();
    expect(parseTransientGeneration("str")).toBeNull();
    expect(parseTransientGeneration(undefined)).toBeNull();
    expect(parseTransientGeneration([])).toBeNull();
  });

  it("任一 id 字段缺失 / 空串 / 非 string 返回 null", () => {
    for (const k of ["invocation_id", "attempt_id", "ownership_id"]) {
      expect(parseTransientGeneration({ ...valid, [k]: undefined })).toBeNull();
      expect(parseTransientGeneration({ ...valid, [k]: "" })).toBeNull();
      expect(parseTransientGeneration({ ...valid, [k]: 123 })).toBeNull();
    }
  });

  it("lease_epoch 必须是十进制字符串（拒 e/hex/符号/数字类型）", () => {
    for (const bad of ["1e3", "0x10", "-1", " 1", "1.0", "", 1, null]) {
      expect(parseTransientGeneration({ ...valid, lease_epoch: bad })).toBeNull();
    }
    expect(parseTransientGeneration({ ...valid, lease_epoch: "0" })).not.toBeNull();
    expect(parseTransientGeneration({ ...valid, lease_epoch: "9007199254740993" })).not.toBeNull();
  });
});

describe("parseGenerationBaseline", () => {
  const valid = {
    thread_id: "t1",
    baseline_sequence: 5,
    issued_revision: 2,
    generations: [
      {
        turn_id: "turn-a",
        generation: { invocation_id: "i", attempt_id: "a", ownership_id: "o", lease_epoch: "1" },
      },
    ],
  };

  it("合法基线解析成功", () => {
    const r = parseGenerationBaseline(valid, "fallback");
    expect(r?.thread_id).toBe("t1");
    expect(r?.baseline_sequence).toBe(5);
    expect(r?.generations[0]?.turn_id).toBe("turn-a");
  });

  it("thread_id 缺失时使用 fallback", () => {
    const { thread_id: _t, ...without } = valid;
    void _t;
    expect(parseGenerationBaseline(without, "fallback")?.thread_id).toBe("fallback");
  });

  it("baseline_sequence / issued_revision 非有限数返回 null", () => {
    expect(parseGenerationBaseline({ ...valid, baseline_sequence: "5" }, "f")).toBeNull();
    expect(parseGenerationBaseline({ ...valid, baseline_sequence: Number.NaN }, "f")).toBeNull();
    expect(
      parseGenerationBaseline({ ...valid, baseline_sequence: Number.POSITIVE_INFINITY }, "f"),
    ).toBeNull();
    expect(parseGenerationBaseline({ ...valid, issued_revision: null }, "f")).toBeNull();
  });

  it("generations 非数组返回 null", () => {
    expect(parseGenerationBaseline({ ...valid, generations: "x" }, "f")).toBeNull();
    expect(parseGenerationBaseline({ ...valid, generations: undefined }, "f")).toBeNull();
  });

  it("generation=null 是明确事实（该 Turn 无活动执行），保留为 null", () => {
    const r = parseGenerationBaseline(
      { ...valid, generations: [{ turn_id: "turn-b", generation: null }] },
      "f",
    );
    expect(r?.generations[0]).toEqual({ turn_id: "turn-b", generation: null });
  });

  it("generation 字段缺失（非 null）视为畸形 → 整个基线返回 null", () => {
    expect(
      parseGenerationBaseline({ ...valid, generations: [{ turn_id: "turn-b" }] }, "f"),
    ).toBeNull();
  });

  it("任一 turn 的 generation 非法 → 整个基线返回 null（不部分接受）", () => {
    const r = parseGenerationBaseline(
      {
        ...valid,
        generations: [
          {
            turn_id: "ok",
            generation: {
              invocation_id: "i",
              attempt_id: "a",
              ownership_id: "o",
              lease_epoch: "1",
            },
          },
          {
            turn_id: "bad",
            generation: {
              invocation_id: "i",
              attempt_id: "a",
              ownership_id: "o",
              lease_epoch: "1e3",
            },
          },
        ],
      },
      "f",
    );
    expect(r).toBeNull();
  });

  it("turn_id 缺失 / 空串返回 null", () => {
    expect(
      parseGenerationBaseline({ ...valid, generations: [{ turn_id: "", generation: null }] }, "f"),
    ).toBeNull();
    expect(
      parseGenerationBaseline({ ...valid, generations: [{ generation: null }] }, "f"),
    ).toBeNull();
  });

  it("空 generations 数组合法", () => {
    const r = parseGenerationBaseline({ ...valid, generations: [] }, "f");
    expect(r?.generations).toEqual([]);
  });
});
