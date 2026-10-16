/**
 * Tab 惰性恢复。
 *
 * Desktop 重启时从 SQLite 读取各 Thread 的 tab 元数据（URL、顺序、activeTabId）。
 * 仅在用户打开 Thread 时惰性恢复，不一次打开所有页面。
 *
 * 恢复只保证 URL 和顺序，不恢复页面内存、未提交表单或滚动位置。
 *
 * 适配实际 schema（001_init.sql）：
 * - thread_tabs 表使用 tab_id / is_incognito / is_active 列
 * - activeTabId 通过 is_active=1 标记在 thread_tabs 行中
 * - device_info 是单行设备信息表，不作为 key-value 存储
 */

import type { MigrationDb } from "../storage/db-interface";
import type { TabId, TabMetadata, ThreadId } from "./tab-store";

/** 持久化的 tab 记录（对应 thread_tabs 表行，字段名转为 camelCase） */
export interface PersistedTab {
  id: string;
  threadId: string;
  url: string;
  title: string;
  position: number;
  incognito: number; // 0 or 1，对应 is_incognito 列
  createdAt: number;
  updatedAt: number;
}

/** Thread 的恢复数据 */
export interface ThreadRestoreData {
  threadId: ThreadId;
  tabs: PersistedTab[];
  activeTabId: TabId | null;
}

/**
 * 将 PersistedTab 转换为 TabMetadata（初始恢复状态）。
 *
 * 恢复的 tab 初始 loadState 为 "idle"，canGoBack/canGoForward 为 false。
 * 实际导航状态在 WebContents 加载后更新。
 */
export function persistedTabToMetadata(tab: PersistedTab): TabMetadata {
  return {
    id: tab.id,
    threadId: tab.threadId,
    url: tab.url,
    title: tab.title,
    favicon: null,
    loadState: "idle",
    canGoBack: false,
    canGoForward: false,
    incognito: tab.incognito === 1,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    error: null,
  };
}

/**
 * TabRestore - 从 SQLite 惰性恢复 Thread 的 tabs。
 *
 * 查询 thread_tabs 表获取指定 Thread 的所有 tab 记录，
 * 按 position 排序，并通过 is_active 列读取 activeTabId。
 */
export class TabRestore {
  constructor(private db: MigrationDb) {}

  /**
   * 恢复指定 Thread 的 tabs。
   * @param threadId - 要恢复的 Thread ID
   * @returns 恢复数据（tabs 按 position 排序 + activeTabId）
   */
  restoreThread(threadId: ThreadId): ThreadRestoreData {
    // 查询 thread_tabs 表，按 position 升序
    const stmt = this.db.prepare(
      "SELECT tab_id, thread_id, url, title, position, is_active, is_incognito, created_at, updated_at FROM thread_tabs WHERE thread_id = ? ORDER BY position ASC",
    );
    const rows = stmt.all(threadId) as Array<{
      tab_id: string;
      thread_id: string;
      url: string;
      title: string | null;
      position: number;
      is_active: number;
      is_incognito: number;
      created_at: number | string;
      updated_at: number | string;
    }>;

    const tabs: PersistedTab[] = rows
      .filter((r) => r.is_incognito !== 1)
      .map((r) => ({
        id: r.tab_id,
        threadId: r.thread_id,
        url: r.url,
        title: r.title ?? "",
        position: r.position,
        incognito: r.is_incognito,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      }));

    // 查找 active tab（is_active = 1 的行）
    let activeTabId: TabId | null = null;
    for (const r of rows) {
      if (r.is_active === 1) {
        activeTabId = r.tab_id;
        break;
      }
    }

    return { threadId, tabs, activeTabId };
  }

  /**
   * 持久化 Thread 的 tabs（新建/更新）。
   *
   * 在单个 transaction 内先删除旧记录再插入新记录，
   * position 按数组顺序写入，activeTabId 通过 is_active=1 标记。
   *
   * @param threadId - Thread ID
   * @param tabs - 要持久化的 tab 元数据列表
   * @param activeTabId - 当前 active tab ID（null 表示无 active）
   */
  persistTabs(threadId: ThreadId, tabs: TabMetadata[], activeTabId: TabId | null): void {
    this.db.transaction(() => {
      // 删除旧记录
      const deleteStmt = this.db.prepare("DELETE FROM thread_tabs WHERE thread_id = ?");
      deleteStmt.run(threadId);

      // 插入新记录
      const insertStmt = this.db.prepare(
        "INSERT INTO thread_tabs (tab_id, thread_id, url, title, position, is_active, is_incognito, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const persistentTabs = tabs.filter((tab) => !tab.incognito);
      for (let i = 0; i < persistentTabs.length; i++) {
        const tab = persistentTabs[i];
        if (!tab) continue;
        const isActive = tab.id === activeTabId ? 1 : 0;
        // thread_id 使用参数值（权威），确保 tabs 归属正确线程
        insertStmt.run(
          tab.id,
          threadId,
          tab.url,
          tab.title,
          i,
          isActive,
          tab.incognito ? 1 : 0,
          tab.createdAt,
          tab.updatedAt,
        );
      }
    });
  }

  /**
   * 删除 Thread 的所有持久化 tabs（Thread 删除时调用）。
   * active 标记随行一起删除，无需额外清理。
   * @returns 删除的行数
   */
  deleteThread(threadId: ThreadId): number {
    const stmt = this.db.prepare("DELETE FROM thread_tabs WHERE thread_id = ?");
    const result = stmt.run(threadId);
    return result.changes;
  }

  /**
   * 获取所有有持久化 tabs 的 Thread ID 列表。
   * 用于 Desktop 重启后知道哪些 Thread 需要恢复。
   */
  getRestorableThreadIds(): ThreadId[] {
    const stmt = this.db.prepare("SELECT DISTINCT thread_id FROM thread_tabs");
    const rows = stmt.all() as Array<{ thread_id: string }>;
    const result: ThreadId[] = [];
    for (const r of rows) {
      result.push(r.thread_id);
    }
    return result;
  }
}

// ─── 恢复编排（从 browser-controller 抽出）─────────────────────────

/** 恢复所需的最小依赖（注入，便于测试）。 */
export interface TabRestoreDeps {
  /** 该 Thread 是否已有状态（有则跳过恢复，避免覆盖用户当前 tabs）。 */
  hasThreadState: (threadId: string) => boolean;
  /** 创建 tab（activate=false 静默创建）。 */
  createTab: (threadId: string, url: string, opts: { tabId: string; activate: false }) => void;
  /** 切换 active tab。 */
  switchTab: (threadId: string, tabId: string) => void;
  /** 恢复期间标记（供外部抑制持久化回写，避免"恢复即写回"震荡）。 */
  markRestoring: (threadId: string) => void;
  clearRestoring: (threadId: string) => void;
  /** 恢复完成后回写一次。 */
  persist: (threadId: string) => void;
}

/** 恢复结果。 */
export interface TabRestoreOutcome {
  /** 是否执行了恢复（false 表示无数据/已有状态）。 */
  readonly restored: boolean;
  /** 实际创建的 tab 数。 */
  readonly created: number;
  /** 最终 active tab id（无则 null）。 */
  readonly activeTabId: string | null;
}

/**
 * 决定本次恢复要创建的 tab 与最终 active tab。
 *
 * 规则（与原实现一致）：
 * - 无历史 tabs → 不恢复
 * - activeTabId 缺失时**回退到第一个 tab**（保证恢复后必有一个可见 tab）
 */
export function planTabRestore(restored: {
  tabs: readonly { id: string; url: string }[];
  activeTabId: string | null;
}): { tabIds: string[]; activeTabId: string | null } | null {
  if (restored.tabs.length === 0) return null;
  const activeTabId = restored.activeTabId ?? restored.tabs[0]?.id ?? null;
  return { tabIds: restored.tabs.map((t) => t.id), activeTabId };
}

/**
 * 执行恢复编排（同步；调用方负责传入已取出的历史数据）。
 *
 * 抽出价值：原 restoreTabs 混合了"读库 + 循环创建 + 切换 + 回写"，
 * 现把**编排顺序与跳过条件**独立出来，可用替身验证
 * （如"已有状态时不创建任何 tab"这类容易写错的条件）。
 */
export function applyTabRestore(
  threadId: string,
  restored: { tabs: readonly { id: string; url: string }[]; activeTabId: string | null },
  deps: TabRestoreDeps,
): TabRestoreOutcome {
  if (deps.hasThreadState(threadId)) {
    return { restored: false, created: 0, activeTabId: null };
  }
  const plan = planTabRestore(restored);
  if (!plan) return { restored: false, created: 0, activeTabId: null };

  deps.markRestoring(threadId);
  try {
    for (const tab of restored.tabs) {
      deps.createTab(threadId, tab.url, { tabId: tab.id, activate: false });
    }
    if (plan.activeTabId) deps.switchTab(threadId, plan.activeTabId);
  } finally {
    deps.clearRestoring(threadId);
  }
  deps.persist(threadId);
  return { restored: true, created: restored.tabs.length, activeTabId: plan.activeTabId };
}
