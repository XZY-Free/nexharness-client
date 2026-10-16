/**
 * UserAction 状态派生规则（纯逻辑，无 React 依赖）。
 *
 * 从 components/thread/items/user-action-item.tsx 抽出。这些规则决定：
 * 「请求是否待处理 / 已解析 / 已超时」以及由此得到的按钮可见性与样式。
 *
 * 安全相关（fail-closed）：
 * - `requestId` 仅接受非空字符串；缺失/空白 → null，**绝不 fallback 到 item.id**
 *   （否则会把「非 Authority 请求」误当成可解析对象）。
 * - 已超时的请求一律不显示操作按钮。
 */
import type { UserActionResolution } from "@/lib/server-schema/user-action-request";
import type { UserActionContent } from "./user-action-fields";

/** 请求状态派生结果。 */
export interface UserActionStatus {
  /** Authority request id（非空 trim 后）；不可用为 null。 */
  readonly requestId: string | null;
  /** 是否已超时（content.state=expired 或 expires_at 已过）。 */
  readonly isExpired: boolean;
  /** 请求是否处于待处理态。 */
  readonly isRequestPending: boolean;
  /** 请求是否已解析。 */
  readonly isResolved: boolean;
  /** 是否展示操作按钮（待处理 且 未超时 且 无已解析结果）。 */
  readonly showActions: boolean;
}

/** item_state 的最小形状（只用到 pending，避免耦合完整 ClientItem）。 */
export interface UserActionItemStateLike {
  readonly item_state?: string;
}

/**
 * 派生 UserAction 的状态。
 *
 * `isRequestPending`：content.state 显式为 pending，或 content.state 缺失且 item 仍 pending。
 * `isResolved`：content.state=resolved，或（非 pending 且非 expired 且 item 非 pending）。
 * `isExpired`：content.state=expired，或 expires_at 早于 now。
 */
export function deriveUserActionStatus(
  content: UserActionContent,
  itemState: UserActionItemStateLike,
  now: number = Date.now(),
): UserActionStatus {
  const isExpired =
    content.state === "expired" ||
    (content.expires_at ? new Date(content.expires_at).getTime() <= now : false);

  // Authority 引用：:resolve 只能使用非空 request_id；缺失/空白 → fail-closed。
  const requestId =
    typeof content.request_id === "string" && content.request_id.trim().length > 0
      ? content.request_id.trim()
      : null;

  const isItemPending = itemState.item_state === "pending";
  const isRequestPending = content.state === "pending" || (!content.state && isItemPending);
  const isResolved =
    content.state === "resolved" || (!isRequestPending && !isExpired && !isItemPending);

  return {
    requestId,
    isExpired,
    isRequestPending,
    isResolved,
    showActions: isRequestPending && !isExpired,
  };
}

/**
 * 最近的解析结果（用于显示"已同意/已拒绝/已提交/已取消"）。
 *
 * 只按 Authority request_id 匹配；request_id 缺失时不回退到 item.id。
 * 若 content.state 已 resolved，则采用 content.resolution。
 */
export function resolveResolvedResolution(
  content: UserActionContent,
  status: UserActionStatus,
  lastResolve: { readonly request_id: string; readonly resolution: UserActionResolution } | null,
): UserActionResolution | null {
  if (status.requestId && lastResolve?.request_id === status.requestId) {
    return lastResolve.resolution;
  }
  return content.state === "resolved" ? (content.resolution ?? null) : null;
}

/** 卡片状态标签与配色。 */
export interface StatusPresentation {
  readonly label: string;
  /** 卡片边框/背景类。 */
  readonly cardClass: string;
  /** 状态小标签底色类。 */
  readonly tagClass: string;
}

/**
 * 派生状态标签与配色（单一函数，避免三处嵌套三元分散且易不一致）。
 */
export function deriveStatusPresentation(
  content: UserActionContent,
  itemState: UserActionItemStateLike,
  status: UserActionStatus,
  resolvedResolution: UserActionResolution | null,
): StatusPresentation {
  if (status.isExpired) {
    return {
      label: "已超时",
      cardClass: "border-destructive/30 bg-destructive/5",
      tagClass: "bg-destructive/10 text-destructive",
    };
  }
  if (resolvedResolution) {
    return {
      label: resolutionLabel(resolvedResolution),
      cardClass: "border-success/25 bg-success/5",
      tagClass: "bg-success/10 text-success",
    };
  }
  if (status.isRequestPending) {
    return {
      label: pendingLabel(content.request_type),
      cardClass: "border-border bg-card",
      tagClass: "bg-muted text-muted-foreground",
    };
  }
  if (itemState.item_state === "completed") {
    return {
      label: "已完成",
      cardClass: "border-border bg-muted/40",
      tagClass: "bg-muted-foreground/10 text-muted-foreground",
    };
  }
  if (itemState.item_state === "failed") {
    return {
      label: "失败",
      cardClass: "border-border bg-muted/40",
      tagClass: "bg-muted-foreground/10 text-muted-foreground",
    };
  }
  return {
    label: "等待处理",
    cardClass: "border-border bg-muted/40",
    tagClass: "bg-muted-foreground/10 text-muted-foreground",
  };
}

/** resolution → 中文（与 user-action-labels 的 getResolutionLabel 同语义，此处内联避免循环依赖）。 */
function resolutionLabel(resolution: UserActionResolution): string {
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

/** 待处理时的标签文案（按 request_type 区分）。 */
function pendingLabel(requestType: string | undefined): string {
  if (requestType === "input") return "需要你的输入";
  if (requestType === "auth") return "需要你授权";
  return "需要你的确认";
}
