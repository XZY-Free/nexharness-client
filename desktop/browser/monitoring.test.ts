import { describe, expect, it, vi } from "vitest";
import {
  type MonitoringDeps,
  type MonitoringTargetLike,
  ensureMonitoringFor,
  monitoringKey,
  releaseMonitoringFor,
} from "./monitoring";

/**
 * 监控启用/释放规则。**失败回滚**（ref 泄漏）是重点：
 * 若 Runtime.enable 成功但 Network.enable 失败却不 release，该 tab 的 debugger
 * 会持续 attached，导致后续 close 异常。
 */
function fakeDeps(over: Partial<MonitoringDeps> = {}) {
  const refs = new Set<string>();
  const acquire = vi.fn(async () => null as MonitoringTargetLike | null);
  const release = vi.fn();
  const deps: MonitoringDeps = {
    acquire,
    release,
    refs: {
      has: (k) => refs.has(k),
      add: (k) => void refs.add(k),
      delete: (k) => refs.delete(k),
    },
    ...over,
  };
  return { deps, refs, acquire, release };
}

function targetOk(...results: boolean[]): MonitoringTargetLike {
  let i = 0;
  return {
    sendCommand: vi.fn(async () => ({ ok: results[i++] ?? true })),
  };
}

describe("monitoringKey", () => {
  it("格式为 threadId:tabId", () => {
    expect(monitoringKey("t1", "tab1")).toBe("t1:tab1");
  });
});

describe("ensureMonitoringFor — 启用与回滚", () => {
  it("已持有 ref → 直接 true 且**不重复 acquire**（幂等）", async () => {
    const { deps, refs, acquire, release } = fakeDeps();
    refs.add("t1:tab1");
    expect(await ensureMonitoringFor("t1:tab1", deps)).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("acquire 失败 → false 且不 release（本来就没持有）", async () => {
    const { deps, release } = fakeDeps();
    expect(await ensureMonitoringFor("t1:tab1", deps)).toBe(false);
    expect(release).not.toHaveBeenCalled();
  });

  it("Runtime.enable 失败 → **release 回滚** 且 false", async () => {
    const { deps, refs, release } = fakeDeps({
      acquire: async () => targetOk(false),
    });
    expect(await ensureMonitoringFor("t1:tab1", deps)).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(refs.size).toBe(0);
  });

  it("Network.enable 失败 → **release 回滚** 且 false（关键：Runtime 已成功的场景）", async () => {
    const { deps, refs, release } = fakeDeps({
      acquire: async () => targetOk(true, false), // Runtime ok, Network fail
    });
    expect(await ensureMonitoringFor("t1:tab1", deps)).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(refs.size).toBe(0);
  });

  it("全部成功 → 持有 ref 且**不 release**（保持 debugger attached）", async () => {
    const { deps, refs, release } = fakeDeps({
      acquire: async () => targetOk(true, true),
    });
    expect(await ensureMonitoringFor("t1:tab1", deps)).toBe(true);
    expect(refs.has("t1:tab1")).toBe(true);
    expect(release).not.toHaveBeenCalled();
  });

  it("成功后再调用 → 幂等 true（仍不重复 acquire）", async () => {
    // 注意：必须用 vi.fn 包装后传入，否则 over 覆盖会丢掉 spy 能力
    const acquire = vi.fn(async () => targetOk(true, true));
    const { deps } = fakeDeps({ acquire });
    await ensureMonitoringFor("t1:tab1", deps);
    await ensureMonitoringFor("t1:tab1", deps);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("先启用 Runtime 再启用 Network（顺序）", async () => {
    const calls: string[] = [];
    const t: MonitoringTargetLike = {
      sendCommand: async (m) => {
        calls.push(m);
        return { ok: true };
      },
    };
    const { deps } = fakeDeps({ acquire: async () => t });
    await ensureMonitoringFor("t1:tab1", deps);
    expect(calls).toEqual(["Runtime.enable", "Network.enable"]);
  });
});

describe("releaseMonitoringFor", () => {
  it("持有 ref → 删除并 release", () => {
    const { deps, refs, release } = fakeDeps();
    refs.add("t1:tab1");
    releaseMonitoringFor("t1:tab1", deps);
    expect(refs.has("t1:tab1")).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("未持有 ref → **不** release（避免多扣）", () => {
    const { deps, release } = fakeDeps();
    releaseMonitoringFor("t1:tab1", deps);
    expect(release).not.toHaveBeenCalled();
  });

  it("重复 release → 只扣一次", () => {
    const { deps, refs, release } = fakeDeps();
    refs.add("t1:tab1");
    releaseMonitoringFor("t1:tab1", deps);
    releaseMonitoringFor("t1:tab1", deps);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("与 ensure 配对：启用后释放回到初始态", async () => {
    const { deps, refs, release } = fakeDeps({ acquire: async () => targetOk(true, true) });
    await ensureMonitoringFor("t1:tab1", deps);
    expect(refs.has("t1:tab1")).toBe(true);
    releaseMonitoringFor("t1:tab1", deps);
    expect(refs.has("t1:tab1")).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
