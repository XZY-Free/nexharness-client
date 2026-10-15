import { StudioShell } from "@/components/studio/studio-shell";
import { Outlet } from "react-router-dom";

/**
 * Studio 布局路由。
 * StudioShell 负责门禁（/studio/api/context）与导航；子路由经 Outlet 渲染。
 */
export default function StudioLayoutRoute() {
  return (
    <StudioShell>
      <Outlet />
    </StudioShell>
  );
}
