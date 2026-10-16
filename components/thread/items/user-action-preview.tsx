import { isStructuredPreview, previewText } from "@/lib/thread/user-action-fields";
import { previewFieldLabel } from "@/lib/thread/user-action-labels";
import { cn } from "@/lib/utils";
/**
 * UserAction 卡片内的独立展示块（从 user-action-item.tsx 抽出）。
 *
 * 这两块是**纯展示**、props 明确，抽出的价值：
 * - 主组件不再持有 60+ 行 JSX
 * - `PreviewValue` 的递归渲染边界可被独立审阅（安全相关：永不把未知对象当 HTML）
 */
import { ChevronDown, ListTree, X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * 递归渲染预览值。
 *
 * 安全口径：只按「字符串 / 数字 / 布尔 / 数组 / 对象」渲染为文本或列表，
 * **永不**把内容当 HTML、链接或可执行内容处理。深度 >= 2 截断，数组取前 12 项，
 * 对象取前 8 键（防超长预览撑破卡片，也限缩陌生结构的暴露面）。
 */
export function PreviewValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return previewText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= 2) return "已省略嵌套内容";
  if (Array.isArray(value)) {
    return (
      <ul className="space-y-0.5">
        {value.slice(0, 12).map((entry, index) => (
          <li
            key={`${depth}:${index}:${typeof entry === "string" ? entry : JSON.stringify(entry)}`}
            className="break-words"
          >
            <PreviewValue value={entry} depth={depth + 1} />
          </li>
        ))}
        {value.length > 12 ? <li>已省略其余项目</li> : null}
      </ul>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 8);
    return (
      <dl className="space-y-1 border-l border-border pl-2">
        {entries.map(([key, nested], index) => (
          <div key={key} className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-2">
            <dt className="max-w-32 truncate text-muted-foreground">
              {previewFieldLabel(key, index)}
            </dt>
            <dd className="min-w-0 break-words">
              <PreviewValue value={nested} depth={depth + 1} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return "—";
}

/**
 * 操作详情折叠区（外部 Agent 经服务端协议校验后的安全预览）。
 */
export function UserActionPreview({
  preview,
  open,
  onToggle,
}: {
  readonly preview: Record<string, unknown> | null;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  if (!isStructuredPreview(preview)) return null;
  return (
    <div className="px-2 pb-1.5 sm:px-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <span className="flex items-center gap-2">
          <ListTree aria-hidden="true" className="size-3.5" strokeWidth={1.6} />
          {open ? "收起操作详情" : "查看操作详情"}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open && "rotate-180")}
          strokeWidth={1.6}
        />
      </button>

      {open ? (
        <section
          aria-label="操作详情"
          className="mx-1 mb-2 rounded-xl bg-muted/55 px-3 py-2.5 text-xs"
        >
          <dl className="space-y-1.5">
            {Object.entries(preview).map(([key, value], index) => (
              <div key={key} className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 leading-5">
                <dt className="truncate text-muted-foreground">{previewFieldLabel(key, index)}</dt>
                <dd className="min-w-0 break-words text-foreground">
                  <PreviewValue value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </div>
  );
}

/** 错误提示条（可关闭）。 */
export function UserActionErrorBanner({
  error,
  onDismiss,
}: {
  readonly error: { readonly title: string; readonly description: string };
  readonly onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="mx-4 mb-3 flex items-center justify-between rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive"
    >
      <span>
        {error.title}：{error.description}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        className="ml-2 flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-destructive/10"
        aria-label="关闭错误提示"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

/** 提示条（request_id 缺失 / 已超时等静态文案）。 */
export function UserActionNotice({
  children,
  tone = "muted",
}: {
  readonly children: ReactNode;
  readonly tone?: "muted" | "alert";
}) {
  return (
    <div
      {...(tone === "alert" ? { role: "alert" } : {})}
      className={cn(
        "mx-4 mb-3 rounded-lg px-3 py-2 text-xs",
        tone === "alert" ? "bg-muted text-foreground" : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
