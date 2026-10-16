import { describe, expect, it } from "vitest";
import { coverageFromSnapshot, evaluateSnapshot } from "./evaluate";
import type { PermissionSnapshot, SnapshotGrant } from "./snapshot";

/**
 * 快照评测是「这个用户能不能做这个动作」的平台边界（fail-closed）。
 * 这些用例锁定：跨租户/非本人拒绝、grant 有效期、agent 使用范围、企业收紧。
 */
function grant(over: Partial<SnapshotGrant> = {}): SnapshotGrant {
  return {
    actionCode: "skill.read",
    resourceScope: { type: "skill", ids: ["s1"], wildcard: false },
    source: "role",
    validFrom: null,
    validUntil: null,
    ...over,
  };
}

function snap(over: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    digest: "d1",
    generatedAt: "2026-01-01T00:00:00Z",
    tenantId: "t1",
    userId: "u1",
    active: true,
    principalIds: ["u1", "p-collab"],
    grants: [],
    policies: [],
    agents: [],
    enterprise: null,
    ...over,
  };
}

describe("evaluateSnapshot — 平台边界", () => {
  it("停用的身份/租户一律拒绝（fail-closed）", () => {
    const r = evaluateSnapshot(snap({ active: false }), {
      actionCode: "skill.read",
      resource: { type: "skill", id: "s1" },
    });
    expect(r.allowed).toBe(false);
  });

  it("跨租户访问拒绝", () => {
    const r = evaluateSnapshot(snap(), {
      actionCode: "audit.read",
      resource: { type: "tenant", id: "other-tenant" },
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("跨租户");
  });

  it("访问非本人 self 资源拒绝", () => {
    const r = evaluateSnapshot(snap(), {
      actionCode: "thread.read",
      resource: { type: "self", id: "other-user" },
    });
    expect(r.allowed).toBe(false);
  });

  it("命中 grant（精确 id）放行并记录 source", () => {
    const r = evaluateSnapshot(snap({ grants: [grant()] }), {
      actionCode: "skill.read",
      resource: { type: "skill", id: "s1" },
    });
    expect(r.allowed).toBe(true);
    expect(r.sources).toContain("role");
  });

  it("wildcard grant 覆盖任意 id", () => {
    const r = evaluateSnapshot(
      snap({ grants: [grant({ resourceScope: { type: "skill", wildcard: true } })] }),
      { actionCode: "skill.read", resource: { type: "skill", id: "any" } },
    );
    expect(r.allowed).toBe(true);
  });

  it("grant 的 id 不含目标资源时拒绝", () => {
    const r = evaluateSnapshot(snap({ grants: [grant()] }), {
      actionCode: "skill.read",
      resource: { type: "skill", id: "other" },
    });
    expect(r.allowed).toBe(false);
  });

  it("actionCode 不匹配的 grant 不生效", () => {
    const r = evaluateSnapshot(snap({ grants: [grant({ actionCode: "skill.write" })] }), {
      actionCode: "skill.read",
      resource: { type: "skill", id: "s1" },
    });
    expect(r.allowed).toBe(false);
  });

  it("已过期的 grant 不生效", () => {
    const r = evaluateSnapshot(snap({ grants: [grant({ validUntil: "2020-01-01T00:00:00Z" })] }), {
      actionCode: "skill.read",
      resource: { type: "skill", id: "s1" },
    });
    expect(r.allowed).toBe(false);
  });

  it("未生效的 grant（validFrom 未来）不生效", () => {
    const r = evaluateSnapshot(snap({ grants: [grant({ validFrom: "2999-01-01T00:00:00Z" })] }), {
      actionCode: "skill.read",
      resource: { type: "skill", id: "s1" },
    });
    expect(r.allowed).toBe(false);
  });

  it("无任何 grant 时拒绝", () => {
    const r = evaluateSnapshot(snap(), {
      actionCode: "skill.read",
      resource: { type: "skill", id: "s1" },
    });
    expect(r.allowed).toBe(false);
  });
});

describe("evaluateSnapshot — agent.invoke 场景", () => {
  const enabledAgent = {
    id: "agent-1",
    ownerUserId: "u1",
    lifecycleState: "enabled",
    currentRevisionId: "rev-1",
    deleted: false,
  };

  it("agent 不存在 → 拒绝", () => {
    const r = evaluateSnapshot(snap(), {
      actionCode: "agent.invoke",
      resource: { type: "agent", id: "ghost" },
    });
    expect(r.allowed).toBe(false);
  });

  it("agent 未启用 / 未发布 → 拒绝", () => {
    const disabled = { ...enabledAgent, lifecycleState: "draft" };
    const r = evaluateSnapshot(snap({ agents: [disabled] }), {
      actionCode: "agent.invoke",
      resource: { type: "agent", id: "agent-1" },
    });
    expect(r.allowed).toBe(false);

    const noRev = { ...enabledAgent, currentRevisionId: null };
    const r2 = evaluateSnapshot(snap({ agents: [noRev] }), {
      actionCode: "agent.invoke",
      resource: { type: "agent", id: "agent-1" },
    });
    expect(r2.allowed).toBe(false);
  });

  it("已删除的 agent → 视为不存在", () => {
    const r = evaluateSnapshot(snap({ agents: [{ ...enabledAgent, deleted: true }] }), {
      actionCode: "agent.invoke",
      resource: { type: "agent", id: "agent-1" },
    });
    expect(r.allowed).toBe(false);
  });

  it("policy mode=all → 全员可用", () => {
    const r = evaluateSnapshot(
      snap({
        agents: [enabledAgent],
        policies: [
          {
            resourceType: "agent",
            resourceId: "agent-1",
            mode: "all",
            principals: null,
            collaborators: null,
            version: 1,
          },
        ],
      }),
      { actionCode: "agent.invoke", resource: { type: "agent", id: "agent-1" } },
    );
    expect(r.allowed).toBe(true);
  });

  it("policy mode=inherit 继承租户默认 policy", () => {
    const r = evaluateSnapshot(
      snap({
        agents: [enabledAgent],
        policies: [
          {
            resourceType: "agent",
            resourceId: "agent-1",
            mode: "inherit",
            principals: null,
            collaborators: null,
            version: 1,
          },
          {
            resourceType: "tenant",
            resourceId: "t1",
            mode: "all",
            principals: null,
            collaborators: null,
            version: 1,
          },
        ],
      }),
      { actionCode: "agent.invoke", resource: { type: "agent", id: "agent-1" } },
    );
    expect(r.allowed).toBe(true);
  });

  it("policy mode=restricted 命中 principals 才放行", () => {
    const hit = evaluateSnapshot(
      snap({
        agents: [enabledAgent],
        policies: [
          {
            resourceType: "agent",
            resourceId: "agent-1",
            mode: "restricted",
            principals: ["u1"],
            collaborators: null,
            version: 1,
          },
        ],
      }),
      { actionCode: "agent.invoke", resource: { type: "agent", id: "agent-1" } },
    );
    expect(hit.allowed).toBe(true);

    const miss = evaluateSnapshot(
      snap({
        principalIds: [],
        agents: [enabledAgent],
        policies: [
          {
            resourceType: "agent",
            resourceId: "agent-1",
            mode: "restricted",
            principals: ["someone"],
            collaborators: null,
            version: 1,
          },
        ],
      }),
      { actionCode: "agent.invoke", resource: { type: "agent", id: "agent-1" } },
    );
    expect(miss.allowed).toBe(false);
  });

  it("agent 管理动作：owner 或协作者放行", () => {
    const owner = evaluateSnapshot(snap({ agents: [enabledAgent] }), {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agent-1" },
    });
    expect(owner.allowed).toBe(true);

    const collab = evaluateSnapshot(
      snap({
        userId: "u2",
        agents: [{ ...enabledAgent, ownerUserId: "u1" }],
        policies: [
          {
            resourceType: "agent",
            resourceId: "agent-1",
            mode: "all",
            principals: null,
            collaborators: [{ principalId: "p-collab", actions: ["agent.publish"] }],
            version: 1,
          },
        ],
      }),
      { actionCode: "agent.publish", resource: { type: "agent", id: "agent-1" } },
    );
    expect(collab.allowed).toBe(true);
  });

  it("非 owner 非协作者的管理动作拒绝", () => {
    const r = evaluateSnapshot(snap({ userId: "stranger", agents: [enabledAgent] }), {
      actionCode: "agent.publish",
      resource: { type: "agent", id: "agent-1" },
    });
    expect(r.allowed).toBe(false);
  });

  it("租户级 tenant scope grant 可满足 agent.invoke（专项授权）", () => {
    const r = evaluateSnapshot(
      snap({
        agents: [enabledAgent],
        grants: [
          grant({ actionCode: "agent.invoke", resourceScope: { type: "tenant", ids: ["t1"] } }),
        ],
        policies: [
          {
            resourceType: "agent",
            resourceId: "agent-1",
            mode: "roles",
            principals: null,
            collaborators: null,
            version: 1,
          },
        ],
      }),
      { actionCode: "agent.invoke", resource: { type: "agent", id: "agent-1" } },
    );
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateSnapshot — 企业收紧", () => {
  const enabledAgent = {
    id: "agent-1",
    ownerUserId: "u1",
    lifecycleState: "enabled",
    currentRevisionId: "rev-1",
    deleted: false,
  };
  const allPolicy = {
    resourceType: "agent",
    resourceId: "agent-1",
    mode: "all",
    principals: null,
    collaborators: null,
    version: 1,
  };

  it("企业决策未允许 → 拒绝（即便平台放行）", () => {
    const r = evaluateSnapshot(
      snap({
        agents: [enabledAgent],
        policies: [allPolicy],
        enterprise: {
          agentIds: "all",
          decisions: { "agent-1": { allowed: false, reason: "企业未授权" } },
        },
      }),
      { actionCode: "agent.invoke", resource: { type: "agent", id: "agent-1" } },
    );
    expect(r.allowed).toBe(false);
    expect(r.sources).toContain("企业授权");
  });

  it("企业决策允许 → 放行并追加来源", () => {
    const r = evaluateSnapshot(
      snap({
        agents: [enabledAgent],
        policies: [allPolicy],
        enterprise: { agentIds: "all", decisions: { "agent-1": { allowed: true } } },
      }),
      { actionCode: "agent.invoke", resource: { type: "agent", id: "agent-1" } },
    );
    expect(r.allowed).toBe(true);
    expect(r.sources).toContain("企业授权");
  });

  it("agent 不在企业白名单范围 → 不追加企业来源", () => {
    const r = evaluateSnapshot(
      snap({
        agents: [enabledAgent],
        policies: [allPolicy],
        enterprise: { agentIds: ["other-agent"], decisions: {} },
      }),
      { actionCode: "agent.invoke", resource: { type: "agent", id: "agent-1" } },
    );
    expect(r.allowed).toBe(true);
    expect(r.sources).not.toContain("企业授权");
  });

  it("非 agent.invoke 动作不应用企业收紧", () => {
    const r = evaluateSnapshot(
      snap({
        grants: [grant()],
        enterprise: { agentIds: "all", decisions: {} },
      }),
      { actionCode: "skill.read", resource: { type: "skill", id: "s1" } },
    );
    expect(r.allowed).toBe(true);
  });
});

describe("coverageFromSnapshot", () => {
  it("汇总该动作的 grant 覆盖（ids + wildcard）", () => {
    const c = coverageFromSnapshot(
      snap({
        grants: [
          grant({ resourceScope: { type: "skill", ids: ["b", "a"] } }),
          grant({ resourceScope: { type: "skill", wildcard: true } }),
        ],
      }),
      { actionCode: "skill.read", resourceType: "skill" },
    );
    expect(c.wildcard).toBe(true);
    expect(c.resourceIds).toEqual(["a", "b"]);
    expect(c.authorizationDigest).toBe("d1");
  });

  it("停用快照返回空覆盖", () => {
    const c = coverageFromSnapshot(snap({ active: false, grants: [grant()] }), {
      actionCode: "skill.read",
      resourceType: "skill",
    });
    expect(c.wildcard).toBe(false);
    expect(c.resourceIds).toEqual([]);
  });

  it("过期 grant 不计入覆盖", () => {
    const c = coverageFromSnapshot(
      snap({ grants: [grant({ validUntil: "2020-01-01T00:00:00Z" })] }),
      { actionCode: "skill.read", resourceType: "skill" },
    );
    expect(c.resourceIds).toEqual([]);
  });

  it("agent.invoke：按逐 agent 评测结果决定覆盖，并关闭 wildcard", () => {
    const c = coverageFromSnapshot(
      snap({
        agents: [
          {
            id: "a1",
            ownerUserId: "u1",
            lifecycleState: "enabled",
            currentRevisionId: "r",
            deleted: false,
          },
          {
            id: "a2",
            ownerUserId: "u1",
            lifecycleState: "draft",
            currentRevisionId: null,
            deleted: false,
          },
        ],
        policies: [
          {
            resourceType: "agent",
            resourceId: "a1",
            mode: "all",
            principals: null,
            collaborators: null,
            version: 1,
          },
        ],
      }),
      { actionCode: "agent.invoke", resourceType: "agent" },
    );
    expect(c.resourceIds).toEqual(["a1"]); // a2 未启用被排除
    expect(c.wildcard).toBe(false);
  });
});
