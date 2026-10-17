import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsLinkRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";

/**
 * 统一管理后台 — 能力与知识页（占位）。
 *
 * 一级导航「能力与知识」整合原 /studio/resources + /studio/skills + /studio/artifacts。
 * 本页为重组后的着陆页，提供到现有子页面的入口。
 *
 * 覆盖：Skill、Tool、Knowledge、模型、连接、来源和风险变化。
 *
 * 门禁（studio.access）由 StudioShell 统一承担（页面数据 API 化）。
 */
export default function CapabilitiesPage() {
  return (
    <StudioPage title="能力与知识" description="管理员工工作时可以使用的技能与智能体。">
      <StudioSettingsSection title="可用能力">
        <StudioSettingsLinkRow
          href="/studio/skills"
          title="技能"
          description="维护技能内容、版本和发布状态。"
        />
        <StudioSettingsLinkRow
          href="/studio/tools"
          title="工具与 MCP"
          description="从能力市场同步工具与 MCP 服务，执行由市场承载。"
        />
        <StudioSettingsLinkRow
          href="/studio/agents"
          title="智能体"
          description="登记智能体，管理版本与员工侧发布。"
        />
      </StudioSettingsSection>
    </StudioPage>
  );
}
