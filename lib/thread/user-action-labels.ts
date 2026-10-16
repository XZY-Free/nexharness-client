/**
 * UserAction 文案映射与时间格式化（纯逻辑，无 React 依赖）。
 *
 * 从 components/thread/items/user-action-item.tsx 抽出。
 */
import type { UserActionResolution } from "@/lib/server-schema/user-action-request";

/** request_type 中文映射。 */
export function getRequestTypeLabel(requestType: string | undefined): string {
  switch (requestType) {
    case "confirmation":
      return "确认请求";
    case "auth":
      return "授权请求";
    case "grant":
      return "权限授予请求";
    case "input":
      return "输入请求";
    default:
      return "操作请求";
  }
}

/** resolution 中文映射。 */
export function getResolutionLabel(resolution: UserActionResolution | null): string {
  switch (resolution) {
    case "approve":
      return "已同意";
    case "deny":
      return "已拒绝";
    case "submit":
      return "已提交";
    case "cancel":
      return "已取消";
    default:
      return "已解析";
  }
}

/**
 * 格式化过期时间倒计时（粗略，不自动刷新）。
 *
 * 未来时间 → "N 分钟/小时/天后超时"；已过或非法 → "已超时" / null。
 */
export function formatExpiresAt(expiresAt: string | undefined): string | null {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return null;
  const now = Date.now();
  if (target <= now) return "已超时";
  const diff = target - now;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后超时`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后超时`;
  const days = Math.floor(hours / 24);
  return `${days} 天后超时`;
}

/**
 * 外部协议键 → 中文标签（键名由外部 Agent 提供，不直接展示给员工）。
 */
export const PREVIEW_FIELD_LABELS: Readonly<Record<string, string>> = {
  leave_type: "假期类型",
  days: "天数",
  dates: "日期",
  reviewer: "审批人",
  command: "命令",
  query: "查询内容",
  url: "网址",
  name: "姓名",
  start_date: "开始日期",
  end_date: "结束日期",
  reason: "事由",
  amount: "金额",
  currency: "币种",
  recipient: "接收方",
};

/** 预览字段标签：已知键用中文，未知键用序号（不暴露裸技术键）。 */
export function previewFieldLabel(key: string, index: number): string {
  return PREVIEW_FIELD_LABELS[key] ?? `信息 ${index + 1}`;
}
