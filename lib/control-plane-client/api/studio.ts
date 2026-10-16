/**
 * Studio API Client — 消费 /studio/api/* 与 /admin/api/agents。
 *
 * 目的（P2-6 统一数据层）：让 Studio 页面的取数走与 control-plane 同一套
 * 传输层与错误模型（`createControlPlaneRequest` → `ControlPlaneRequestError`），
 * 而不再各自手搓 fetch + 错误分支。
 *
 * 注意：本 client 的方法**抛错**（与其它 control-plane client 一致）；
 * 页面的 loading/error 状态机由 `useApiData`（薄封装）承载，
 * 它内部调用本 client 并把错误归一为 `AppError`。
 */
import type {
  AgentCountWire,
  GovernanceWire,
  PermissionRulesWire,
  SkillDetailWire,
  SkillListWireRow,
  SkillVersionWire,
  StudioAuditWire,
} from "../contracts/studio";
import { type ApiClientConfig, createControlPlaneRequest } from "../http-client";

/** Studio API Client。 */
export interface StudioApiClient {
  /** 技能列表；withSync 时携带同步状态字段。 */
  listSkills(params?: { withSync?: boolean }): Promise<SkillListWireRow[]>;
  /** 技能详情。 */
  getSkill(id: string): Promise<SkillDetailWire>;
  /** 技能版本列表。 */
  listSkillVersions(id: string): Promise<SkillVersionWire[]>;
  /** 治理配置。 */
  getGovernance(): Promise<GovernanceWire>;
  /** 权限规则。 */
  getPermissionRules(): Promise<PermissionRulesWire>;
  /** 审计日志。 */
  getAudit(): Promise<StudioAuditWire>;
  /** Agent 总数（overview 用）。 */
  getAgentCount(): Promise<AgentCountWire>;
}

/** 创建 Studio API Client。 */
export function createStudioApiClient(config: ApiClientConfig): StudioApiClient {
  const request = createControlPlaneRequest(config);
  return {
    listSkills: ({ withSync } = {}) =>
      request<SkillListWireRow[]>(`/studio/api/skills${withSync ? "?withSync=1" : ""}`),
    getSkill: (id) => request<SkillDetailWire>(`/studio/api/skills/${encodeURIComponent(id)}`),
    listSkillVersions: (id) =>
      request<SkillVersionWire[]>(`/studio/api/skills/${encodeURIComponent(id)}/versions`),
    getGovernance: () => request<GovernanceWire>("/studio/api/governance"),
    getPermissionRules: () => request<PermissionRulesWire>("/studio/api/permission-rules"),
    getAudit: () => request<StudioAuditWire>("/studio/api/audit"),
    getAgentCount: () => request<AgentCountWire>("/admin/api/agents"),
  };
}
