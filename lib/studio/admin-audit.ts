/**
 * Studio 审计行的客户端类型投影。
 *
 * 服务端查询实现（listStudioAuditEvents / 审计脱敏）留在 nexharness；
 * 客户端只需要展示行的 wire 形状（经 /studio/api/audit 返回）。
 */
import type { AuditEvent } from "@/lib/persistence/schema/audit";

export type StudioAuditRow = AuditEvent & {
  actorName: string | null;
  actorEmail: string | null;
};
