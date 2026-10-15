import { StudioPage } from "@/components/studio/studio-page";
import {
  StudioSettingsRow,
  StudioSettingsSection,
} from "@/components/studio/studio-settings-section";

/**
 * 统一管理后台 — 观测与评测页（占位）。
 *
 * 一级导航「观测与评测」展示 Event、Trace、Observation、Evaluation、实验和告警。
 *
 *   「观测与评测」：Event、Trace、Observation、Evaluation、实验和告警
 *
 * 门禁（studio.access）由 StudioShell 统一承担（页面数据 API 化）。
 */
export default function ObservabilityPage() {
  const unavailable = (
    <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">尚未开放</span>
  );

  return (
    <StudioPage title="观测与评测" description="查看智能体运行情况、质量结果与异常提醒。">
      <StudioSettingsSection title="运行质量">
        <StudioSettingsRow title="调用追踪" description="查看一次任务中各个步骤的运行情况。">
          {unavailable}
        </StudioSettingsRow>
        <StudioSettingsRow title="质量评测" description="汇总质量检查与验收结果。">
          {unavailable}
        </StudioSettingsRow>
        <StudioSettingsRow title="异常提醒" description="集中查看需要处理的运行异常。">
          {unavailable}
        </StudioSettingsRow>
      </StudioSettingsSection>
    </StudioPage>
  );
}
