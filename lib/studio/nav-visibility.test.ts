import type { PermissionSnapshot, SnapshotGrant } from "@/lib/identity-client/snapshot";
import { describe, expect, it } from "vitest";
import {
  NAV_ACTION_MAPPING,
  STUDIO_NAV_IDS,
  type StudioNavId,
  navVisibilityFromSnapshot,
} from "./nav-visibility";

/**
 * 导航可见性是权限的本地投影（UX 层；服务端仍需校验）。
 * 这些用例锁定：fail-closed（异常/无权限 → 全隐藏）、按 action 集合逐项判定。
 */
function grant(actionCode: string): SnapshotGrant {
  return {
    actionCode,
    resourceScope: { type: "tenant", ids: ["t1"] },
    source: "role",
    validFrom: null,
    validUntil: null,
  };
}

function snap(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    digest: "d1",
    generatedAt: "2026-01-01T00:00:00Z",
    tenantId: "t1",
    userId: "u1",
    active: true,
    principalIds: ["u1"],
    grants: [grant("studio.access")],
    policies: [],
    agents: [],
    enterprise: null,
    ...over,
  };
}

describe("目录常量", () => {
  it("STUDIO_NAV_IDS 有 8 个一级菜单", () => {
    expect(STUDIO_NAV_IDS.length).toBe(8);
  });

  it("每个菜单都有 action 映射（无缺配）", () => {
    for (const id of STUDIO_NAV_IDS) {
      expect(NAV_ACTION_MAPPING[id].length).toBeGreaterThan(0);
    }
  });
});

describe("navVisibilityFromSnapshot — fail-closed", () => {
  it("快照 inactive → 全部隐藏", () => {
    const v = navVisibilityFromSnapshot(snap({ active: false }));
    expect(Object.values(v).every((x) => x === false)).toBe(true);
  });

  it("无 studio.access → 全部隐藏", () => {
    const v = navVisibilityFromSnapshot(snap({ grants: [] }));
    expect(Object.values(v).every((x) => x === false)).toBe(true);
  });

  it("无任何 action 绑定 → 全部隐藏", () => {
    // 有 studio.access 但 grants 仅此一项仍算 1 个 action；用一个不映射到菜单的 action
    const v = navVisibilityFromSnapshot(
      snap({ grants: [grant("studio.access"), grant("audit.export")] }),
    );
    // audit.export 映射到 security
    expect(v.security).toBe(true);
  });
});

describe("navVisibilityFromSnapshot — 按 action 集合逐项判定", () => {
  it("持有 agents 相关 action → agents 可见", () => {
    const v = navVisibilityFromSnapshot(
      snap({ grants: [grant("studio.access"), grant("agent.publish")] }),
    );
    expect(v.agents).toBe(true);
  });

  it("持有 skill.create → capabilities 可见", () => {
    const v = navVisibilityFromSnapshot(
      snap({ grants: [grant("studio.access"), grant("skill.create")] }),
    );
    expect(v.capabilities).toBe(true);
  });

  it("任一映射 action 命中即可见（some 语义）", () => {
    const v = navVisibilityFromSnapshot(
      snap({ grants: [grant("studio.access"), grant("job.retry")] }),
    );
    expect(v.conversations).toBe(true);
  });

  it("未持有对应 action 的菜单隐藏", () => {
    const v = navVisibilityFromSnapshot(
      snap({ grants: [grant("studio.access"), grant("skill.create")] }),
    );
    expect(v.agents).toBe(false);
    expect(v.runtime).toBe(false);
    expect(v.settings).toBe(false);
  });

  it("全量授权 → 全部可见", () => {
    const allActions = new Set<string>();
    for (const id of STUDIO_NAV_IDS) {
      for (const a of NAV_ACTION_MAPPING[id]) allActions.add(a);
    }
    const v = navVisibilityFromSnapshot(
      snap({ grants: [grant("studio.access"), ...[...allActions].map(grant)] }),
    );
    for (const id of STUDIO_NAV_IDS) {
      expect(v[id as StudioNavId]).toBe(true);
    }
  });

  it("studio.access 本身不使任何菜单可见（不作为菜单 action）", () => {
    const v = navVisibilityFromSnapshot(snap({ grants: [grant("studio.access")] }));
    expect(Object.values(v).every((x) => x === false)).toBe(true);
  });

  it("结果包含全部 8 个键（形状稳定）", () => {
    const v = navVisibilityFromSnapshot(snap());
    expect(Object.keys(v).sort()).toEqual([...STUDIO_NAV_IDS].sort());
  });
});
