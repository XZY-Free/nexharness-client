import { describe, expect, it } from "vitest";
import {
  compareLeaseEpoch,
  findAuthoritativeGeneration,
  isDecimalLeaseEpoch,
  isNewerGenerationBaseline,
  matchesGenerationBaseline,
  nextThreadGenerationRevision,
  sameThreadGeneration,
  sameThreadGenerationFacts,
  sameThreadGenerationTuples,
  serializeThreadGenerationBaseline,
  threadGenerationKey,
} from "./thread-generation";

/**
 * 代际比较是跨代隔离的判定基础（thread-reducer 依赖它）。
 * 这些用例锁定：epoch 必须 BigInt 比较（禁 Number）、tuple 精确匹配不降级。
 */
function gen(over: Partial<Parameters<typeof threadGenerationKey>[0]> = {}) {
  return {
    invocationId: "inv1",
    attemptId: "att1",
    ownershipId: "own1",
    leaseEpoch: "1",
    ...over,
  };
}

describe("isDecimalLeaseEpoch", () => {
  it("接受纯十进制字符串", () => {
    expect(isDecimalLeaseEpoch("0")).toBe(true);
    expect(isDecimalLeaseEpoch("123")).toBe(true);
    expect(isDecimalLeaseEpoch("999999999999999999999999")).toBe(true);
  });

  it("拒绝科学计数/十六进制/符号/空白/非字符串", () => {
    for (const v of ["1e3", "0x10", "-1", " 1", "1 ", "1.0", "", "abc"]) {
      expect(isDecimalLeaseEpoch(v)).toBe(false);
    }
    expect(isDecimalLeaseEpoch(123)).toBe(false);
    expect(isDecimalLeaseEpoch(null)).toBe(false);
    expect(isDecimalLeaseEpoch(undefined)).toBe(false);
  });
});

describe("compareLeaseEpoch — BigInt 精度", () => {
  it("数值序比较", () => {
    expect(compareLeaseEpoch("1", "2")).toBe(-1);
    expect(compareLeaseEpoch("2", "1")).toBe(1);
    expect(compareLeaseEpoch("2", "2")).toBe(0);
  });

  it("超出 Number.MAX_SAFE_INTEGER 仍精确（防静默丢精度）", () => {
    // 2^53 与 2^53+1：Number 会判等，BigInt 不会
    const a = "9007199254740992"; // 2^53
    const b = "9007199254740993"; // 2^53 + 1
    expect(Number(a) === Number(b)).toBe(true); // 证明 Number 会误判
    expect(compareLeaseEpoch(a, b)).toBe(-1);
    expect(compareLeaseEpoch(b, a)).toBe(1);
  });

  it("位数不同但数值序正确（字符串比较会错）", () => {
    expect(compareLeaseEpoch("9", "10")).toBe(-1); // 字符串比较 "9" > "10"
  });
});

describe("sameThreadGeneration — 四项全比", () => {
  it("完全相同返回 true", () => {
    expect(sameThreadGeneration(gen(), gen())).toBe(true);
  });

  it("任一字段不同返回 false（不做只比 epoch 的宽松等价）", () => {
    expect(sameThreadGeneration(gen(), gen({ invocationId: "x" }))).toBe(false);
    expect(sameThreadGeneration(gen(), gen({ attemptId: "x" }))).toBe(false);
    expect(sameThreadGeneration(gen(), gen({ ownershipId: "x" }))).toBe(false);
    expect(sameThreadGeneration(gen(), gen({ leaseEpoch: "2" }))).toBe(false);
  });

  it("null 语义：双 null 为 true，一 null 一非 null 为 false", () => {
    expect(sameThreadGeneration(null, null)).toBe(true);
    expect(sameThreadGeneration(null, gen())).toBe(false);
    expect(sameThreadGeneration(gen(), null)).toBe(false);
  });
});

describe("threadGenerationKey", () => {
  it("包含四项，任一变化即不同", () => {
    expect(threadGenerationKey(gen())).toBe("inv1:att1:own1:1");
    expect(threadGenerationKey(gen({ leaseEpoch: "2" }))).not.toBe(threadGenerationKey(gen()));
  });
});

describe("findAuthoritativeGeneration — 三态语义", () => {
  const baseline = {
    threadId: "t",
    baselineSequence: 1,
    issuedRevision: 1,
    generations: [
      { turnId: "turn-a", generation: gen() },
      { turnId: "turn-b", generation: null },
    ],
  };

  it("无基线 → undefined（未覆盖，需暂存）", () => {
    expect(findAuthoritativeGeneration(null, "turn-a")).toBeUndefined();
  });

  it("基线未覆盖该 turn → undefined", () => {
    expect(findAuthoritativeGeneration(baseline, "turn-unknown")).toBeUndefined();
  });

  it("基线明确无活动执行（generation=null）→ null", () => {
    expect(findAuthoritativeGeneration(baseline, "turn-b")).toBeNull();
  });

  it("有权威代际 → 返回该 tuple", () => {
    expect(findAuthoritativeGeneration(baseline, "turn-a")).toEqual(gen());
  });
});

describe("matchesGenerationBaseline", () => {
  const baseline = {
    threadId: "t",
    baselineSequence: 1,
    issuedRevision: 1,
    generations: [{ turnId: "turn-a", generation: gen() }],
  };

  it("恰好属于当前代际返回 true", () => {
    expect(matchesGenerationBaseline({ turnId: "turn-a", generation: gen() }, baseline)).toBe(true);
  });

  it("代际不完全一致返回 false（精确匹配，不降级）", () => {
    expect(
      matchesGenerationBaseline(
        { turnId: "turn-a", generation: gen({ attemptId: "other" }) },
        baseline,
      ),
    ).toBe(false);
  });

  it("未覆盖 / 无基线返回 false", () => {
    expect(matchesGenerationBaseline({ turnId: "x", generation: gen() }, baseline)).toBe(false);
    expect(matchesGenerationBaseline({ turnId: "turn-a", generation: gen() }, null)).toBe(false);
  });
});

describe("isNewerGenerationBaseline", () => {
  const mk = (over = {}) => ({
    threadId: "t",
    baselineSequence: 1,
    issuedRevision: 1,
    generations: [],
    ...over,
  });

  it("无当前基线 → 总是采用", () => {
    expect(isNewerGenerationBaseline(mk(), null)).toBe(true);
  });

  it("游标更大 → 采用；更小 → 不采用", () => {
    expect(
      isNewerGenerationBaseline(mk({ baselineSequence: 5 }), mk({ baselineSequence: 3 })),
    ).toBe(true);
    expect(
      isNewerGenerationBaseline(mk({ baselineSequence: 3 }), mk({ baselineSequence: 5 })),
    ).toBe(false);
  });

  it("游标相同 → 用进程内发号排序（接管不一定新增持久事件）", () => {
    expect(
      isNewerGenerationBaseline(
        mk({ baselineSequence: 5, issuedRevision: 2 }),
        mk({ baselineSequence: 5, issuedRevision: 1 }),
      ),
    ).toBe(true);
    expect(
      isNewerGenerationBaseline(
        mk({ baselineSequence: 5, issuedRevision: 1 }),
        mk({ baselineSequence: 5, issuedRevision: 2 }),
      ),
    ).toBe(false);
  });

  it("游标相同且发号也相同 → 不采用（幂等）", () => {
    expect(isNewerGenerationBaseline(mk(), mk())).toBe(false);
  });
});

describe("sameThreadGenerationTuples / sameThreadGenerationFacts", () => {
  it("tuple 集合与顺序完全一致才为 true", () => {
    const a = [{ turnId: "t1", generation: gen() }];
    expect(sameThreadGenerationTuples(a, [{ turnId: "t1", generation: gen() }])).toBe(true);
    expect(sameThreadGenerationTuples(a, [])).toBe(false);
    expect(
      sameThreadGenerationTuples(a, [{ turnId: "t1", generation: gen({ leaseEpoch: "2" }) }]),
    ).toBe(false);
    expect(sameThreadGenerationTuples(a, [{ turnId: "t2", generation: gen() }])).toBe(false);
  });

  it("null generation 也要逐项比对", () => {
    expect(
      sameThreadGenerationTuples(
        [{ turnId: "t", generation: null }],
        [{ turnId: "t", generation: null }],
      ),
    ).toBe(true);
    expect(
      sameThreadGenerationTuples(
        [{ turnId: "t", generation: null }],
        [{ turnId: "t", generation: gen() }],
      ),
    ).toBe(false);
  });

  it("facts 额外比对 baselineSequence", () => {
    const g = [{ turnId: "t1", generation: gen() }];
    expect(
      sameThreadGenerationFacts(
        { baselineSequence: 1, generations: g },
        { baselineSequence: 1, generations: g },
      ),
    ).toBe(true);
    expect(
      sameThreadGenerationFacts(
        { baselineSequence: 1, generations: g },
        { baselineSequence: 2, generations: g },
      ),
    ).toBe(false);
  });
});

describe("serializeThreadGenerationBaseline — snake_case 线上格式", () => {
  it("按契约输出 snake_case 字段", () => {
    const out = serializeThreadGenerationBaseline({
      threadId: "t1",
      baselineSequence: 7,
      issuedRevision: 3,
      generations: [{ turnId: "turn-a", generation: gen() }],
    });
    expect(out).toEqual({
      thread_id: "t1",
      baseline_sequence: 7,
      issued_revision: 3,
      generations: [
        {
          turn_id: "turn-a",
          generation: {
            invocation_id: "inv1",
            attempt_id: "att1",
            ownership_id: "own1",
            lease_epoch: "1",
          },
        },
      ],
    });
  });

  it("null generation 序列化为 null", () => {
    const out = serializeThreadGenerationBaseline({
      threadId: "t1",
      baselineSequence: 1,
      issuedRevision: 1,
      generations: [{ turnId: "turn-b", generation: null }],
    }) as { generations: Array<{ generation: unknown }> };
    expect(out.generations[0]?.generation).toBeNull();
  });

  it("lease_epoch 保持字符串（不做 Number 转换）", () => {
    const big = "9007199254740993"; // 2^53 + 1
    const out = serializeThreadGenerationBaseline({
      threadId: "t",
      baselineSequence: 1,
      issuedRevision: 1,
      generations: [{ turnId: "x", generation: gen({ leaseEpoch: big }) }],
    }) as { generations: Array<{ generation: { lease_epoch: string } }> };
    expect(out.generations[0]?.generation.lease_epoch).toBe(big);
  });
});

describe("nextThreadGenerationRevision", () => {
  it("进程内单调递增", () => {
    const a = nextThreadGenerationRevision();
    const b = nextThreadGenerationRevision();
    const c = nextThreadGenerationRevision();
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });
});
