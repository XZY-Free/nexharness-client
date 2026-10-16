/**
 * Studio（管理后台）端点的 wire 契约。
 *
 * 此前这些 DTO 分散在各 `src/routes/studio-*.tsx` 文件内（`SkillListWireRow` 甚至
 * 在 skills 与 overview 两处重复定义）。集中到此，避免漂移。
 *
 * 命名沿用 `*Wire` —— 表示"服务端返回的线上形状"，与领域模型区分。
 */

/** GET /studio/api/skills（含 ?withSync=1）列表行。 */
export interface SkillListWireRow {
  readonly id: string;
  readonly skillKey: string;
  readonly displayName: string | null;
  readonly sourceType: string;
  readonly lifecycleState: string;
  readonly syncState?: string | null;
  readonly lastSyncedAt?: string | null;
}

/** GET /studio/api/skills/[id] 响应。 */
export interface SkillDetailWire {
  skill: {
    id: string;
    skillKey: string;
    displayName: string | null;
    description: string | null;
    sourceType: string;
    lifecycleState: string;
    visibilityScope: string;
    currentVersionId: string | null;
  };
  currentVersion: unknown;
  syncInfo: {
    syncState: string;
    remoteAssetId: string;
    remoteName: string | null;
    remoteDisplayName: string | null;
    remoteVersion: string | null;
    remoteContentHash: string | null;
    lastSyncedAt: string | null;
    lastError: string | null;
  } | null;
}

/** GET /studio/api/skills/[id]/versions 行。 */
export interface SkillVersionWire {
  readonly id: string;
  readonly versionNo: number;
  readonly revisionState: string;
  readonly createdAt: string;
  readonly contentRef: string | null;
  readonly manifestJson: unknown;
}

/** GET /studio/api/governance 响应（与编辑器 props 对齐）。 */
export interface GovernanceWire {
  set: { versionNo: number };
  config: {
    protectedPaths: string[];
    commandDenyList: string[];
    formatOnWrite: boolean;
    verifyBeforeDelivery: boolean;
    harnessLoopLimits?: {
      maxLoopSteps?: number;
      maxAgentCalls?: number;
      maxToolCalls?: number;
      maxKnowledgeSearches?: number;
      maxConsecutiveSameAction?: number;
    };
  };
  revision: { revisionNo: number; publishedAt: string | null };
}

/** GET /studio/api/permission-rules 响应。 */
export interface PermissionRulesWire {
  set: { versionNo: number };
  defaultDecision: "allow" | "pause" | "block";
  rules: Array<{
    id: string;
    ruleKey: string;
    toolPattern: string;
    argMatcher: unknown;
    decision: "allow" | "pause" | "block";
    scope: unknown;
    priority: number;
    reason: string | null;
  }>;
  revision: { revisionNo: number; publishedAt: string | null };
}

/** GET /studio/api/audit 响应。 */
export interface StudioAuditWire {
  logs: Array<{
    id: string;
    actionType: string;
    actorType: string;
    targetType: string | null;
    targetId: string | null;
    createdAt: string;
    [key: string]: unknown;
  }>;
}

/** GET /admin/api/agents 的总数视图（overview 页面用）。 */
export interface AgentCountWire {
  total: number;
}
