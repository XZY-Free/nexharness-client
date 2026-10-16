import { describe, expect, it } from "vitest";
import { TempFileRegistry } from "./temp-file-registry";

/**
 * 临时文件注册表决定「哪些本机文件在哪儿被清理」（漏注册=文件泄漏，误删=丢数据）。
 * 这些用例锁定：filePath 全局唯一、幂等注册、值拷贝（外部改动不污染内部）。
 */
describe("register", () => {
  it("注册后可查询，返回值拷贝", () => {
    const r = new TempFileRegistry();
    const e = r.register("t1", "/tmp/a.png", "screenshot");
    expect(e.threadId).toBe("t1");
    expect(e.filePath).toBe("/tmp/a.png");
    expect(e.category).toBe("screenshot");
    expect(r.has("/tmp/a.png")).toBe(true);
  });

  it("幂等：同 filePath 重复注册不产生重复条目，且更新字段", () => {
    const r = new TempFileRegistry();
    r.register("t1", "/tmp/a.png", "screenshot");
    r.register("t2", "/tmp/a.png", "download");
    expect(r.size()).toBe(1);
    const [e] = r.listByThread("t2");
    expect(e?.threadId).toBe("t2");
    expect(e?.category).toBe("download");
    expect(r.listByThread("t1").length).toBe(0); // 已迁移到 t2
  });

  it("返回的 entry 是拷贝（外部修改不污染内部）", () => {
    const r = new TempFileRegistry();
    const e = r.register("t1", "/tmp/a.png", "screenshot");
    e.threadId = "hacked";
    expect(r.listByThread("t1")[0]?.threadId).toBe("t1");
  });
});

describe("unregister / has", () => {
  it("unregister 返回被移除条目并使其不可查", () => {
    const r = new TempFileRegistry();
    r.register("t1", "/tmp/a.png", "screenshot");
    const removed = r.unregister("/tmp/a.png");
    expect(removed?.filePath).toBe("/tmp/a.png");
    expect(r.has("/tmp/a.png")).toBe(false);
  });

  it("unregister 未注册路径返回 undefined（幂等，不抛错）", () => {
    const r = new TempFileRegistry();
    expect(r.unregister("/tmp/ghost")).toBeUndefined();
  });

  it("未注册路径 has 为 false", () => {
    expect(new TempFileRegistry().has("/tmp/x")).toBe(false);
  });
});

describe("listByThread / clearThread", () => {
  it("listByThread 只返回该 thread 条目", () => {
    const r = new TempFileRegistry();
    r.register("t1", "/tmp/a", "screenshot");
    r.register("t1", "/tmp/b", "download");
    r.register("t2", "/tmp/c", "artifact");
    expect(
      r
        .listByThread("t1")
        .map((e) => e.filePath)
        .sort(),
    ).toEqual(["/tmp/a", "/tmp/b"]);
    expect(r.listByThread("t2").length).toBe(1);
  });

  it("listByThread 空 thread 返回空数组", () => {
    expect(new TempFileRegistry().listByThread("nope")).toEqual([]);
  });

  it("clearThread 移除该 thread 全部并返回条目（供调用方 unlink）", () => {
    const r = new TempFileRegistry();
    r.register("t1", "/tmp/a", "screenshot");
    r.register("t1", "/tmp/b", "download");
    r.register("t2", "/tmp/c", "artifact");
    const cleared = r.clearThread("t1");
    expect(cleared.length).toBe(2);
    expect(r.listByThread("t1")).toEqual([]);
    expect(r.listByThread("t2").length).toBe(1); // 不误伤其它 thread
  });

  it("clearThread 无该 thread 返回空数组", () => {
    expect(new TempFileRegistry().clearThread("nope")).toEqual([]);
  });
});

describe("clearAll", () => {
  it("移除全部并返回所有条目", () => {
    const r = new TempFileRegistry();
    r.register("t1", "/tmp/a", "screenshot");
    r.register("t2", "/tmp/b", "download");
    const all = r.clearAll();
    expect(all.length).toBe(2);
    expect(r.size()).toBe(0);
  });

  it("空注册表 clearAll 返回空数组", () => {
    expect(new TempFileRegistry().clearAll()).toEqual([]);
  });
});

describe("size", () => {
  it("反映当前条目数（filePath 全局唯一）", () => {
    const r = new TempFileRegistry();
    expect(r.size()).toBe(0);
    r.register("t1", "/tmp/a", "screenshot");
    r.register("t2", "/tmp/b", "download");
    expect(r.size()).toBe(2);
    r.unregister("/tmp/a");
    expect(r.size()).toBe(1);
  });

  it("不同 thread 的同名路径只算一个（路径全局唯一）", () => {
    const r = new TempFileRegistry();
    r.register("t1", "/tmp/same", "screenshot");
    r.register("t2", "/tmp/same", "screenshot");
    expect(r.size()).toBe(1);
  });
});
