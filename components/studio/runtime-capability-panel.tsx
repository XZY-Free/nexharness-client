import type { RuntimeCapability } from "@/lib/runtime/types";

/**
 * Studio runtime capability 面板（只读展示）。
 *
 * 展示 runtimeType / imageVersion / networkPolicy + enforced / quotas + enforced /
 * secretMount / available。host 模式诚实展示 open + not enforced（不伪装有硬隔离）。
 */

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        ok
          ? "bg-[var(--success-surface)] text-[var(--success-on-surface)]"
          : "bg-[var(--warning-surface)] text-[var(--warning-on-surface)]"
      }`}
    >
      {label}
    </span>
  );
}

export function RuntimeCapabilityPanel({ capability }: { capability?: RuntimeCapability }) {
  if (!capability) {
    return (
      <div className="text-[13px] text-[var(--muted-foreground)]">runtime capability 不可用。</div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-[13px]">
      <section className="rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--card)] p-3">
        <h3 className="mb-2 text-[14px] font-medium text-[var(--foreground)]">Runtime 能力</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--muted-foreground)]">
          <dt>类型</dt>
          <dd className="font-mono text-[var(--foreground)]">{capability.runtimeType}</dd>
          {capability.imageVersion && (
            <>
              <dt>镜像</dt>
              <dd className="font-mono text-[var(--foreground)]">{capability.imageVersion}</dd>
            </>
          )}
          <dt>可用</dt>
          <dd>
            <StatusBadge
              ok={capability.available}
              label={capability.available ? "可用" : "不可用"}
            />
          </dd>
          {capability.degradedFrom && (
            <>
              <dt>降级</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <StatusBadge ok={false} label={`由 ${capability.degradedFrom} 降级`} />
                {capability.degradedReason && (
                  <span className="font-mono text-[11px] text-[var(--muted-foreground)]">
                    {capability.degradedReason}
                  </span>
                )}
              </dd>
            </>
          )}
          <dt>secret 挂载</dt>
          <dd>
            <StatusBadge
              ok={capability.secretMount}
              label={capability.secretMount ? "已启用" : "未启用"}
            />
          </dd>
        </dl>
      </section>

      <section className="rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--card)] p-3">
        <h3 className="mb-2 text-[14px] font-medium text-[var(--foreground)]">网络策略</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--muted-foreground)]">
          <dt>策略</dt>
          <dd className="font-mono text-[var(--foreground)]">{capability.networkPolicy}</dd>
          <dt>强制执行</dt>
          <dd>
            {capability.networkPolicyEnforced ? (
              <StatusBadge ok={true} label="已强制" />
            ) : (
              <StatusBadge ok={false} label="未强制（host 模式，诚实标注）" />
            )}
          </dd>
        </dl>
        {!capability.networkPolicyEnforced && (
          <p className="mt-2 text-[11px] text-[var(--muted-foreground)]">
            host 模式是信任平台进程，无法硬隔离 egress；网络策略标记为 open +
            未强制，不伪装有硬隔离。
          </p>
        )}
      </section>

      <section className="rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--card)] p-3">
        <h3 className="mb-2 text-[14px] font-medium text-[var(--foreground)]">资源配额</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[var(--muted-foreground)]">
          <dt>CPU</dt>
          <dd className="font-mono text-[var(--foreground)]">{capability.quotas.cpu ?? "—"}</dd>
          <dt>内存</dt>
          <dd className="font-mono">{capability.quotas.memory ?? "—"}</dd>
          <dt>超时</dt>
          <dd className="font-mono">
            {capability.quotas.timeoutMs ? `${capability.quotas.timeoutMs}ms` : "—"}
          </dd>
          <dt>日志上限</dt>
          <dd className="font-mono">
            {capability.quotas.logCapBytes ? `${capability.quotas.logCapBytes} bytes` : "—"}
          </dd>
          <dt>强制执行</dt>
          <dd>
            {capability.quotaEnforced ? (
              <StatusBadge ok={true} label="硬配额（cgroup）" />
            ) : (
              <StatusBadge ok={false} label="soft limit（host 模式）" />
            )}
          </dd>
        </dl>
      </section>
    </div>
  );
}
