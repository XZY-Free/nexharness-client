import { Navigate, useSearchParams } from "react-router-dom";

/**
 * 数据分析旧入口（搬迁自 nexharness app/studio/analytics/page.tsx）。
 * 已合并到「总览」页；保留路由作向后兼容重定向，scope 透传。
 */
export default function StudioAnalyticsRoute() {
  const [params] = useSearchParams();
  return (
    <Navigate to={params.get("scope") === "global" ? "/studio?scope=global" : "/studio"} replace />
  );
}
