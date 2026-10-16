import { describe, expect, it } from "vitest";
import {
  ACTION_CODES,
  ACTION_RESOURCE_TYPES,
  RESOURCE_SCOPE_TYPES,
  ResourceScopeError,
  assertActionResourceTypeMatch,
  isKnownActionCode,
  isKnownResourceScopeType,
} from "./action-codes";

/**
 * action code / resource scope 是授权判定的目录 —— 越权 = 匹配错目录。
 * 这些用例锁定：未知码拒绝、action↔scope 配对严格。
 */
describe("isKnownResourceScopeType", () => {
  it("目录内类型返回 true", () => {
    for (const t of RESOURCE_SCOPE_TYPES) {
      expect(isKnownResourceScopeType(t)).toBe(true);
    }
  });

  it("目录外返回 false", () => {
    for (const t of ["unknown", "", "TENANT", "tenant ", "*"]) {
      expect(isKnownResourceScopeType(t)).toBe(false);
    }
  });
});

describe("isKnownActionCode", () => {
  it("目录内动作返回 true", () => {
    expect(isKnownActionCode("skill.publish")).toBe(true);
    expect(isKnownActionCode("thread.write")).toBe(true);
    expect(isKnownActionCode("security.incident.isolate")).toBe(true);
  });

  it("未知 / 大小写不符返回 false", () => {
    expect(isKnownActionCode("skill.hack")).toBe(false);
    expect(isKnownActionCode("SKILL.PUBLISH")).toBe(false);
    expect(isKnownActionCode("")).toBe(false);
    expect(isKnownActionCode("thread.write.all")).toBe(false);
  });
});

describe("assertActionResourceTypeMatch", () => {
  it("合法配对不抛错", () => {
    expect(() => assertActionResourceTypeMatch("skill.publish", "skill")).not.toThrow();
    expect(() => assertActionResourceTypeMatch("thread.write", "self")).not.toThrow();
    expect(() => assertActionResourceTypeMatch("thread.read", "tenant")).not.toThrow();
  });

  it("非法配对抛 scope_type_mismatch（越权防护）", () => {
    // thread.write 不允许 skill scope
    expect(() => assertActionResourceTypeMatch("thread.write", "skill")).toThrow(
      ResourceScopeError,
    );
    try {
      assertActionResourceTypeMatch("thread.write", "skill");
    } catch (e) {
      expect((e as ResourceScopeError).code).toBe("scope_type_mismatch");
    }
  });

  it("每个 action 的允许 scope 都在全局目录内（防目录漂移）", () => {
    for (const [action, scopes] of Object.entries(ACTION_RESOURCE_TYPES)) {
      expect(scopes.length).toBeGreaterThan(0);
      for (const s of scopes) {
        expect(isKnownResourceScopeType(s)).toBe(true);
      }
    }
  });

  it("每个合法配对都能通过校验（拒绝集与允许集一致）", () => {
    for (const [action, scopes] of Object.entries(ACTION_RESOURCE_TYPES)) {
      for (const s of scopes) {
        expect(() => assertActionResourceTypeMatch(action as never, s as never)).not.toThrow();
      }
    }
  });
});

describe("目录常量", () => {
  it("ACTION_CODES 与 ACTION_RESOURCE_TYPES 键集合一致（无缺配）", () => {
    const codes = new Set<string>(ACTION_CODES);
    const mapped = new Set(Object.keys(ACTION_RESOURCE_TYPES));
    for (const c of codes) {
      expect(mapped.has(c)).toBe(true);
    }
    for (const m of mapped) {
      expect(codes.has(m)).toBe(true);
    }
  });

  it("ACTION_CODES 无重复项", () => {
    expect(new Set(ACTION_CODES).size).toBe(ACTION_CODES.length);
  });

  it("RESOURCE_SCOPE_TYPES 无重复项", () => {
    expect(new Set(RESOURCE_SCOPE_TYPES).size).toBe(RESOURCE_SCOPE_TYPES.length);
  });
});
