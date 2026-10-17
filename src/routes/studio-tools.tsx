import { useApiData } from "@/components/hooks/use-api-data";
import { StudioGatePage } from "@/components/studio/gate-page";
import { StudioPage } from "@/components/studio/studio-page";
import { useStudioContext } from "@/components/studio/studio-shell";
import { ToolSyncButton } from "@/components/studio/tool-sync-button";
import { Badge } from "@/components/ui/badge";
import { snapshotAllowsTenantAction } from "@/lib/client/studio-permissions";

/** /studio/api/tools 列表行（wire 形状，仅取展示所需字段）。 */
interface StudioToolWireRow {
  id: string;
  toolKey: string;
  displayName: string;
  description: string | null;
  lifecycleState: string;
  riskClass: string;
  providerKey: string;
  providerType: string;
  syncState: string | null;
  syncAssetType: string | null;
  lastSyncedAt: string | null;
}

const PROVIDER_TYPE_LABEL: Record<string, string> = {
  builtin: "内置",
  custom: "工具库",
  mcp: "MCP",
  webhook: "Webhook",
  script: "脚本",
  http_openapi: "OpenAPI",
};

const LIFECYCLE_LABEL: Record<string, string> = {
  draft: "草稿",
  enabled: "可用",
  disabled: "已归档",
  retired: "已停用",
};

const SYNC_STATE_LABEL: Record<string, string> = {
  active: "已同步",
  blocked: "暂停更新",
  hidden: "来源已隐藏",
  not_found: "来源已下线",
  error: "同步失败",
};

const RISK_LABEL: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "极高",
};

/**
 * Studio 工具与 MCP 列表页。
 *
 * - 数据来自 GET /studio/api/tools（服务端按 tool.read 守卫）。
 * - tool.write 决定「同步工具与 MCP」入口显隐（快照轻量断言）。
 */
export default function ToolsPage() {
  const { snapshot } = useStudioContext();
  const canWrite = snapshotAllowsTenantAction(snapshot, "tool.write");
  const { data, loading, httpStatus, errorMessage } =
    useApiData<StudioToolWireRow[]>("/studio/api/tools");

  const tools = data ?? [];

  return (
    <StudioPage
      title="工具与 MCP"
      description="管理能力市场同步的工具与 MCP 服务。执行由能力市场承载，本地负责编排与权限。"
      actions={canWrite ? <ToolSyncButton /> : null}
    >
      {httpStatus !== null ? (
        <div className="px-5 py-6">
          <StudioGatePage
            status={httpStatus === 0 ? 500 : httpStatus}
            message={errorMessage ?? "加载失败，请稍后重试"}
          />
        </div>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          暂无工具。可通过右上角从能力市场同步工具与 MCP 服务。
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">工具</th>
                <th className="px-4 py-3 text-left font-medium">来源</th>
                <th className="px-4 py-3 text-left font-medium">风险</th>
                <th className="px-4 py-3 text-left font-medium">状态</th>
                <th className="px-4 py-3 text-left font-medium">同步状态</th>
                <th className="px-4 py-3 text-left font-medium">最近同步</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => (
                <tr key={tool.id} className="border-t border-border">
                  <td className="px-4 py-3">
                    <div className="font-medium">{tool.displayName}</div>
                    <div className="text-xs text-muted-foreground">{tool.toolKey}</div>
                    {tool.description && (
                      <div className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
                        {tool.description}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline">
                      {PROVIDER_TYPE_LABEL[tool.providerType] ?? tool.providerType}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">{RISK_LABEL[tool.riskClass] ?? tool.riskClass}</td>
                  <td className="px-4 py-3">
                    {LIFECYCLE_LABEL[tool.lifecycleState] ?? tool.lifecycleState}
                  </td>
                  <td className="px-4 py-3">
                    {tool.syncState ? (
                      <>
                        {SYNC_STATE_LABEL[tool.syncState] ?? "状态未知"}
                        {tool.syncAssetType && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({tool.syncAssetType === "mcp" ? "MCP" : "工具库"})
                          </span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {tool.lastSyncedAt
                      ? new Date(tool.lastSyncedAt).toLocaleString("zh-CN", { hour12: false })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </StudioPage>
  );
}
