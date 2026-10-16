import { describe, expect, it } from "vitest";
import type { MigrationDb } from "../storage/db-interface";
import { TabRestore, persistedTabToMetadata } from "./tab-restore";
import type { TabMetadata } from "./tab-store";

/**
 * TabRestore 决定「重启后哪些 tab 会回来」——incognito 绝不能落盘/恢复。
 * 这些用例用内存 fake DB 锁定：incognito 过滤、position 顺序、active 标记、事务语义。
 */

/** 最小内存 fake，模拟 thread_tabs 表的 prepare/run/all/transaction。 */
function makeFakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    rows,
    prepare(sql: string) {
      if (sql.startsWith("SELECT tab_id")) {
        return {
          all: (threadId: string) =>
            rows
              .filter((r) => r.thread_id === threadId)
              .sort((a, b) => (a.position as number) - (b.position as number)),
        };
      }
      if (sql.startsWith("DELETE FROM thread_tabs")) {
        return {
          run: (threadId: string) => {
            const before = rows.length;
            for (let i = rows.length - 1; i >= 0; i--) {
              if (rows[i]?.thread_id === threadId) rows.splice(i, 1);
            }
            return { changes: before - rows.length };
          },
        };
      }
      if (sql.startsWith("INSERT INTO thread_tabs")) {
        return {
          run: (
            tab_id: string,
            thread_id: string,
            url: string,
            title: string,
            position: number,
            is_active: number,
            is_incognito: number,
            created_at: number,
            updated_at: number,
          ) => {
            rows.push({
              tab_id,
              thread_id,
              url,
              title,
              position,
              is_active,
              is_incognito,
              created_at,
              updated_at,
            });
            return { changes: 1 };
          },
        };
      }
      if (sql.startsWith("SELECT DISTINCT")) {
        return {
          all: () => [...new Set(rows.map((r) => r.thread_id))].map((thread_id) => ({ thread_id })),
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    transaction(fn: () => void) {
      fn(); // fake 无回滚语义，仅验证被调用
    },
  };
  return db as unknown as MigrationDb & { rows: Array<Record<string, unknown>> };
}

function tabMeta(over: Partial<TabMetadata> = {}): TabMetadata {
  return {
    id: "tab1",
    threadId: "t1",
    url: "https://x/a",
    title: "A",
    favicon: null,
    loadState: "idle",
    canGoBack: false,
    canGoForward: false,
    incognito: false,
    createdAt: 1000,
    updatedAt: 2000,
    error: null,
    ...over,
  };
}

describe("persistedTabToMetadata", () => {
  it("把 incognito=1 转为 true，其它字段就位", () => {
    const m = persistedTabToMetadata({
      id: "x",
      threadId: "t",
      url: "https://x",
      title: "T",
      position: 0,
      incognito: 1,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(m.incognito).toBe(true);
    expect(m.loadState).toBe("idle");
    expect(m.canGoBack).toBe(false);
    expect(m.canGoForward).toBe(false);
    expect(m.favicon).toBeNull();
    expect(m.error).toBeNull();
  });

  it("incognito=0 转为 false", () => {
    const m = persistedTabToMetadata({
      id: "x",
      threadId: "t",
      url: "u",
      title: "T",
      position: 0,
      incognito: 0,
      createdAt: 1,
      updatedAt: 2,
    });
    expect(m.incognito).toBe(false);
  });
});

describe("TabRestore.persistTabs", () => {
  it("按数组顺序写入 position；active 标记打在对应行", () => {
    const db = makeFakeDb();
    const r = new TabRestore(db);
    r.persistTabs(
      "t1",
      [
        tabMeta({ id: "a", url: "https://a" }),
        tabMeta({ id: "b", url: "https://b" }),
        tabMeta({ id: "c", url: "https://c" }),
      ],
      "b",
    );

    const byId = Object.fromEntries(db.rows.map((row) => [row.tab_id, row]));
    expect(byId.a?.position).toBe(0);
    expect(byId.b?.position).toBe(1);
    expect(byId.c?.position).toBe(2);
    expect(byId.b?.is_active).toBe(1);
    expect(byId.a?.is_active).toBe(0);
    expect(byId.c?.is_active).toBe(0);
  });

  it("incognito tab 不落盘（隐私约束）", () => {
    const db = makeFakeDb();
    const r = new TabRestore(db);
    r.persistTabs(
      "t1",
      [tabMeta({ id: "normal" }), tabMeta({ id: "secret", incognito: true })],
      "normal",
    );
    expect(db.rows.map((row) => row.tab_id)).toEqual(["normal"]);
  });

  it("重复 persistTabs 先清旧记录（幂等，不累积）", () => {
    const db = makeFakeDb();
    const r = new TabRestore(db);
    r.persistTabs("t1", [tabMeta({ id: "a" })], "a");
    r.persistTabs("t1", [tabMeta({ id: "b" })], "b");
    expect(db.rows.map((row) => row.tab_id)).toEqual(["b"]);
  });

  it("thread_id 用参数值（权威），不被 tab 自带的 threadId 污染", () => {
    const db = makeFakeDb();
    const r = new TabRestore(db);
    r.persistTabs("real-thread", [tabMeta({ id: "a", threadId: "wrong-thread" })], null);
    expect(db.rows[0]?.thread_id).toBe("real-thread");
  });

  it("activeTabId 为 null 时无 active 行", () => {
    const db = makeFakeDb();
    const r = new TabRestore(db);
    r.persistTabs("t1", [tabMeta({ id: "a" })], null);
    expect(db.rows.every((row) => row.is_active === 0)).toBe(true);
  });
});

describe("TabRestore.restoreThread", () => {
  it("按 position 升序返回，且跳过 incognito 行", () => {
    const db = makeFakeDb();
    db.rows.push(
      {
        tab_id: "b",
        thread_id: "t1",
        url: "https://b",
        title: "B",
        position: 1,
        is_active: 0,
        is_incognito: 0,
        created_at: 1,
        updated_at: 1,
      },
      {
        tab_id: "a",
        thread_id: "t1",
        url: "https://a",
        title: "A",
        position: 0,
        is_active: 1,
        is_incognito: 0,
        created_at: 1,
        updated_at: 1,
      },
      {
        tab_id: "inc",
        thread_id: "t1",
        url: "https://inc",
        title: "I",
        position: 2,
        is_active: 0,
        is_incognito: 1,
        created_at: 1,
        updated_at: 1,
      },
    );
    const r = new TabRestore(db);
    const data = r.restoreThread("t1");
    expect(data.tabs.map((t) => t.id)).toEqual(["a", "b"]); // position 序 + 排除 incognito
    expect(data.activeTabId).toBe("a");
  });

  it("title 为 null 时兜底为空串", () => {
    const db = makeFakeDb();
    db.rows.push({
      tab_id: "a",
      thread_id: "t1",
      url: "u",
      title: null,
      position: 0,
      is_active: 0,
      is_incognito: 0,
      created_at: 1,
      updated_at: 1,
    });
    const data = new TabRestore(db).restoreThread("t1");
    expect(data.tabs[0]?.title).toBe("");
  });

  it("created_at 为字符串时转为数字", () => {
    const db = makeFakeDb();
    db.rows.push({
      tab_id: "a",
      thread_id: "t1",
      url: "u",
      title: "T",
      position: 0,
      is_active: 0,
      is_incognito: 0,
      created_at: "123",
      updated_at: "456",
    });
    const data = new TabRestore(db).restoreThread("t1");
    expect(data.tabs[0]?.createdAt).toBe(123);
    expect(data.tabs[0]?.updatedAt).toBe(456);
  });

  it("无记录返回空列表 + null active", () => {
    const data = new TabRestore(makeFakeDb()).restoreThread("nope");
    expect(data.tabs).toEqual([]);
    expect(data.activeTabId).toBeNull();
  });

  it("往返一致：persist 后 restore 得到相同顺序与 active", () => {
    const db = makeFakeDb();
    const r = new TabRestore(db);
    const tabs = [
      tabMeta({ id: "a", url: "https://a" }),
      tabMeta({ id: "b", url: "https://b" }),
      tabMeta({ id: "c", url: "https://c" }),
    ];
    r.persistTabs("t1", tabs, "c");
    const data = r.restoreThread("t1");
    expect(data.tabs.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(data.activeTabId).toBe("c");
  });
});

describe("TabRestore.deleteThread / getRestorableThreadIds", () => {
  it("deleteThread 返回删除行数且不影响其它 thread", () => {
    const db = makeFakeDb();
    const r = new TabRestore(db);
    r.persistTabs("t1", [tabMeta({ id: "a" }), tabMeta({ id: "b" })], "a");
    r.persistTabs("t2", [tabMeta({ id: "c" })], "c");
    expect(r.deleteThread("t1")).toBe(2);
    expect(db.rows.map((row) => row.tab_id)).toEqual(["c"]);
  });

  it("getRestorableThreadIds 去重列出有 tab 的 thread", () => {
    const db = makeFakeDb();
    const r = new TabRestore(db);
    r.persistTabs("t1", [tabMeta({ id: "a" }), tabMeta({ id: "b" })], "a");
    r.persistTabs("t2", [tabMeta({ id: "c" })], "c");
    expect(r.getRestorableThreadIds().sort()).toEqual(["t1", "t2"]);
  });
});
