import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ChatComposerRoute from "./routes/chat";
import ChatThreadRoute from "./routes/chat-thread";
import LoginRoute from "./routes/login";
import { NotFoundView } from "./routes/not-found";
import { RouteErrorView } from "./routes/route-error";

/**
 * NexHarness Web SPA 路由表。
 *
 * - /chat、/chat/:threadId：使用端；/studio/*：管理后台（StudioShell 门禁与导航）。
 * - /login：登录入口（客户端 302 到 auth-center，票据经 /api/session/exchange 落地）。
 * - 兼容重定向：/、/studio/agents、/studio/analytics、/studio/artifacts。
 *
 * 分包策略：
 * - **员工端主路径（/chat、/login、404）静态引入** —— 它们是首屏，等待分包反而变慢。
 * - **Studio 后台（/studio/*）全部动态分包** —— 管理后台是少数人使用的低频路径，
 *   却带着 20 个页面与重型编辑器依赖；若并入首屏会让所有员工都下载它。
 *   Studio 与其子路由由同一个 Suspense 边界兜底（Outlet 内的挂起会上浮到这里），
 *   因此切换 Studio 子页面时只加载该页 chunk，外壳不闪烁。
 */
const StudioLayoutRoute = lazy(() => import("./routes/studio-layout"));
const StudioAgentDetailRoute = lazy(() => import("./routes/studio-agent-detail"));
const StudioAnalyticsRoute = lazy(() => import("./routes/studio-analytics"));
const StudioAuditRoute = lazy(() => import("./routes/studio-audit"));
const StudioCapabilitiesRoute = lazy(() => import("./routes/studio-capabilities"));
const StudioGovernanceRoute = lazy(() => import("./routes/studio-governance"));
const StudioObservabilityRoute = lazy(() => import("./routes/studio-observability"));
const StudioOperationsRoute = lazy(() => import("./routes/studio-operations"));
const StudioOverviewRoute = lazy(() => import("./routes/studio-overview"));
const StudioPermissionRulesRoute = lazy(() => import("./routes/studio-permission-rules"));
const StudioResourcesRoute = lazy(() => import("./routes/studio-resources"));
const StudioRuntimeRoute = lazy(() => import("./routes/studio-runtime"));
const StudioSecurityRoute = lazy(() => import("./routes/studio-security"));
const StudioSettingsRoute = lazy(() => import("./routes/studio-settings"));
const StudioSkillDetailRoute = lazy(() => import("./routes/studio-skill-detail"));
const StudioSkillsRoute = lazy(() => import("./routes/studio-skills"));

/** Studio 分包加载中的占位（保持与 StudioShell 相同的底色，避免闪白）。 */
function StudioLoading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background text-sm text-muted-foreground">
      正在加载管理后台…
    </div>
  );
}

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
          <Route
            path="/studio"
            element={
              <Suspense fallback={<StudioLoading />}>
                <StudioLayoutRoute />
              </Suspense>
            }
          >
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
