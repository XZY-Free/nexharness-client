import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ChatComposerRoute from "./routes/chat";
import ChatThreadRoute from "./routes/chat-thread";
import LoginRoute from "./routes/login";
import { NotFoundView } from "./routes/not-found";
import { RouteErrorView } from "./routes/route-error";
import StudioAgentDetailRoute from "./routes/studio-agent-detail";
import StudioAnalyticsRoute from "./routes/studio-analytics";
import StudioAuditRoute from "./routes/studio-audit";
import StudioCapabilitiesRoute from "./routes/studio-capabilities";
import StudioGovernanceRoute from "./routes/studio-governance";
import StudioLayoutRoute from "./routes/studio-layout";
import StudioObservabilityRoute from "./routes/studio-observability";
import StudioOperationsRoute from "./routes/studio-operations";
import StudioOverviewRoute from "./routes/studio-overview";
import StudioPermissionRulesRoute from "./routes/studio-permission-rules";
import StudioResourcesRoute from "./routes/studio-resources";
import StudioRuntimeRoute from "./routes/studio-runtime";
import StudioSecurityRoute from "./routes/studio-security";
import StudioSettingsRoute from "./routes/studio-settings";
import StudioSkillDetailRoute from "./routes/studio-skill-detail";
import StudioSkillsRoute from "./routes/studio-skills";

/**
 * NexHarness Web SPA 路由表。
 *
 * - /chat、/chat/:threadId：使用端；/studio/*：管理后台（StudioShell 门禁与导航）。
 * - /login：登录入口（客户端 302 到 auth-center，票据经 /api/session/exchange 落地）。
 * - 兼容重定向：/、/studio/agents、/studio/analytics、/studio/artifacts。
 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, "");

export function ClientApp() {
  return (
    <BrowserRouter basename={basename === "" ? "/" : basename}>
      <Routes>
        <Route errorElement={<RouteErrorView />}>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/chat" element={<ChatComposerRoute />} />
          <Route path="/chat/:threadId" element={<ChatThreadRoute />} />
          <Route path="/studio" element={<StudioLayoutRoute />}>
            <Route index element={<StudioOverviewRoute />} />
            <Route path="analytics" element={<StudioAnalyticsRoute />} />
            <Route path="artifacts" element={<Navigate to="/studio" replace />} />
            <Route path="audit" element={<StudioAuditRoute />} />
            <Route path="capabilities" element={<StudioCapabilitiesRoute />} />
            <Route path="governance" element={<StudioGovernanceRoute />} />
            <Route path="observability" element={<StudioObservabilityRoute />} />
            <Route path="operations" element={<StudioOperationsRoute />} />
            <Route path="permission-rules" element={<StudioPermissionRulesRoute />} />
            <Route path="resources" element={<StudioResourcesRoute />} />
            <Route path="runtime" element={<StudioRuntimeRoute />} />
            <Route path="security" element={<StudioSecurityRoute />} />
            <Route path="settings" element={<StudioSettingsRoute />} />
            <Route path="agents" element={<Navigate to="/studio/resources?tab=agents" replace />} />
            <Route path="agents/:agent_id" element={<StudioAgentDetailRoute />} />
            <Route path="skills" element={<StudioSkillsRoute />} />
            <Route path="skills/:id" element={<StudioSkillDetailRoute />} />
          </Route>
          <Route path="*" element={<NotFoundView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
