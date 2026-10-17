import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-fetch";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

/**
 * 从已配置的能力市场同步工具与 MCP（tool / mcp）。
 * 可见性由服务端权限判断（tool.write）。
 */
export function ToolSyncButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch("/studio/api/tools/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error?.message ?? "同步失败，请稍后重试");
        return;
      }
      const d = body;
      setResult({
        新导入: d.imported?.length ?? 0,
        已更新: d.updated?.length ?? 0,
        已是最新: d.uptodate?.length ?? 0,
        被远端阻止: d.blocked?.length ?? 0,
        失败: d.failed?.length ?? 0,
      });
      window.location.reload();
    } catch {
      setError("网络连接失败，未能同步能力市场");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button type="button" onClick={run} disabled={busy} variant="outline">
        <RefreshCw
          data-icon="inline-start"
          aria-hidden
          className={busy ? "animate-spin" : undefined}
        />
        {busy ? "同步中…" : "同步工具与 MCP"}
      </Button>
      {error && (
        <span role="alert" className="max-w-72 text-right text-xs text-destructive">
          {error}
        </span>
      )}
      {result && (
        <output className="max-w-96 text-right text-xs text-muted-foreground">
          {Object.entries(result)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k} ${n}`)
            .join(" · ") || "无变化"}
        </output>
      )}
    </div>
  );
}
