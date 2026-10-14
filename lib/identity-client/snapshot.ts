/**
 * 权限快照类型（客户端并集）。
 *
 * 搬迁自 nexharness `lib/identity-client/snapshot.ts` 的**类型定义部分**：
 * 客户端只消费快照数据结构与纯函数评测（evaluate.ts），不包含拉取 / 缓存 /
 * 凭证注册等消费链逻辑（那些留在 nexharness 服务端）。
 */

export interface SnapshotResourceScope {
  readonly type: string;
  readonly ids?: readonly string[];
  readonly wildcard?: boolean;
}

export interface SnapshotGrant {
  readonly actionCode: string;
  readonly resourceScope: SnapshotResourceScope;
  readonly source: string;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export interface SnapshotPolicy {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly mode: string;
  readonly principals: unknown;
  readonly collaborators: unknown;
  readonly version: number;
}

export interface SnapshotAgent {
  readonly id: string;
  readonly ownerUserId: string;
  readonly lifecycleState: string;
  readonly currentRevisionId: string | null;
  readonly deleted: boolean;
}

export interface SnapshotEnterprise {
  readonly agentIds: "all" | readonly string[];
  readonly decisions: Readonly<Record<string, { allowed: boolean; reason?: string }>>;
}

export interface PermissionSnapshot {
  readonly digest: string;
  readonly generatedAt: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly active: boolean;
  readonly principalIds: readonly string[];
  readonly grants: readonly SnapshotGrant[];
  readonly policies: readonly SnapshotPolicy[];
  readonly agents: readonly SnapshotAgent[];
  readonly enterprise: SnapshotEnterprise | null;
}
