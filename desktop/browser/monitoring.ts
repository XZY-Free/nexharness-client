/**
 * 页面监控（Runtime + Network 域）的启用/释放规则 —— 从 browser-controller 抽出。
 *
 * 抽出价值：
 * 1. **失败回滚**是正确性关键：Runtime.enable 成功、Network.enable 失败时，
 *    必须先 release 掉 acquire 到的 debugger ref，否则 ref 泄漏导致该 tab
 *    永远无法正常 close（debugger 持续 attached）。
 *    原实现有 3 处 release（acquire 失败 / Runtime 失败 / Network 失败），
 *    但**没有测试**。现在由测试固化。
 * 2. 幂等：已在监控中（ref 存在）→ 直接返回 true，不重复 acquire。
 * 3. ref 计数语义：release 仅在有 ref 时才真正 release（避免多扣）。
 */

/** CDP 目标最小接口。 */
export interface MonitoringTargetLike {
  sendCommand(method: string, params?: unknown): Promise<{ ok: boolean }>;
}

/** 监控依赖（注入，便于测试）。 */
export interface MonitoringDeps {
  /** acquire debugger ref；失败返回 null。 */
  acquire: () => Promise<MonitoringTargetLike | null>;
  /** release debugger ref。 */
  release: () => void;
  /** ref 集合（按 `${threadId}:${tabId}` 键）。 */
  refs: {
    has(key: string): boolean;
    add(key: string): void;
    delete(key: string): boolean;
  };
}

/** 构造监控 ref 键。 */
export function monitoringKey(threadId: string, tabId: string): string {
  return `${threadId}:${tabId}`;
}

/**
 * 启用监控（Runtime + Network 域）。
 *
 * 顺序与回滚：
 * 1. 已有 ref → 直接 true（幂等，不重复 acquire）
 * 2. acquire 失败 → false（无需回滚）
 * 3. Runtime.enable 失败 → **release 后** false
 * 4. Network.enable 失败 → **release 后** false
 * 5. 全部成功 → 持有 ref（不 release，保持 debugger attached）并 true
 *
 * @returns true 表示监控已启用
 */
export async function ensureMonitoringFor(key: string, deps: MonitoringDeps): Promise<boolean> {
  if (deps.refs.has(key)) return true;

  const target = await deps.acquire();
  if (!target) return false;

  const runtimeResult = await target.sendCommand("Runtime.enable");
  if (!runtimeResult.ok) {
    deps.release();
    return false;
  }

  const networkResult = await target.sendCommand("Network.enable");
  if (!networkResult.ok) {
    deps.release();
    return false;
  }

  // 持有 ref（不 release），保持 debugger 持续 attached
  deps.refs.add(key);
  return true;
}

/**
 * 释放监控 ref。
 *
 * 仅在确实持有 ref 时才 release（避免多扣导致 ref 计数失衡）。
 */
export function releaseMonitoringFor(key: string, deps: MonitoringDeps): void {
  if (deps.refs.has(key)) {
    deps.refs.delete(key);
    deps.release();
  }
}
