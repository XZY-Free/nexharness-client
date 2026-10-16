import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationRequiredError,
  type ThreadApiFetch,
  createNewThreadSession,
  loadThreadShell,
} from "./new-thread-session";

/**
 * 新会话提交是「首条消息幂等 + 失败后可重试且不可改内容」的状态机。
 * 这些用例锁定：401 → 鉴权错误、幂等键复用、失败后换内容被拒、重试复用已有 thread。
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function submission(over: Record<string, unknown> = {}) {
  return {
    text: "hello",
    modelRef: "m1",
    permissionMode: "auto" as const,
    ...over,
  } as never;
}

describe("loadThreadShell", () => {
  it("成功返回解析后的 body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ threads: [{ id: "t1" }] }));
    const out = await loadThreadShell(fetchImpl as ThreadApiFetch);
    expect(out).toEqual({ threads: [{ id: "t1" }] });
  });

  it("401 抛 AuthenticationRequiredError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    await expect(loadThreadShell(fetchImpl as ThreadApiFetch)).rejects.toBeInstanceOf(
      AuthenticationRequiredError,
    );
  });

  it("服务端错误 message 被透出（若有 body）", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "服务端拒绝" } }, 500));
    await expect(loadThreadShell(fetchImpl as ThreadApiFetch)).rejects.toThrow("服务端拒绝");
  });

  it("非 JSON body 时退回默认提示", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    await expect(loadThreadShell(fetchImpl as ThreadApiFetch)).rejects.toThrow("无法读取会话列表");
  });
});

describe("createNewThreadSession — 首次提交", () => {
  it("先创建 thread 再发 turn，返回 thread 摘要", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/threads") return jsonResponse({ id: "t1", title: "T" });
      return jsonResponse({ ok: true });
    });
    const session = createNewThreadSession({ fetchImpl: fetchImpl as ThreadApiFetch });
    const thread = await session.submit(submission());
    expect(thread.id).toBe("t1");
    expect(calls).toEqual(["POST /api/threads", "POST /api/threads/t1/turns"]);
  });

  it("创建 thread 带 idempotency-key 头", async () => {
    const headers: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (path: string, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      if (path === "/api/threads") return jsonResponse({ id: "t1" });
      return jsonResponse({});
    });
    const session = createNewThreadSession({
      fetchImpl: fetchImpl as ThreadApiFetch,
      idempotencyKeyFactory: () => "fixed-key",
    });
    await session.submit(submission());
    expect(headers[0]?.["idempotency-key"]).toBe("fixed-key");
  });

  it("401 抛 AuthenticationRequiredError", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const session = createNewThreadSession({ fetchImpl: fetchImpl as ThreadApiFetch });
    await expect(session.submit(submission())).rejects.toBeInstanceOf(AuthenticationRequiredError);
  });

  it("创建失败抛服务端 message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "配额不足" } }, 429));
    const session = createNewThreadSession({ fetchImpl: fetchImpl as ThreadApiFetch });
    await expect(session.submit(submission())).rejects.toThrow("配额不足");
  });
});

describe("createNewThreadSession — 失败后重试", () => {
  it("turn 失败后重试不重复创建 thread（复用 pending）", async () => {
    let threadCreates = 0;
    let turnAttempts = 0;
    const fetchImpl = vi.fn(async (path: string) => {
      if (path === "/api/threads") {
        threadCreates++;
        return jsonResponse({ id: "t1" });
      }
      turnAttempts++;
      return turnAttempts === 1
        ? jsonResponse({ error: { message: "boom" } }, 500)
        : jsonResponse({});
    });
    const session = createNewThreadSession({ fetchImpl: fetchImpl as ThreadApiFetch });
    await expect(session.submit(submission())).rejects.toThrow("boom");
    const thread = await session.submit(submission()); // 同内容重试
    expect(thread.id).toBe("t1");
    expect(threadCreates).toBe(1); // 未重复创建
  });

  it("失败后换内容被拒绝（防首条消息悄悄替换）", async () => {
    const fetchImpl = vi.fn(async (path: string) => {
      if (path === "/api/threads") return jsonResponse({ id: "t1" });
      return jsonResponse({ error: { message: "boom" } }, 500);
    });
    const session = createNewThreadSession({ fetchImpl: fetchImpl as ThreadApiFetch });
    await expect(session.submit(submission())).rejects.toThrow();
    await expect(session.submit(submission({ text: "different" }))).rejects.toThrow(
      "不能更换模型或消息内容",
    );
  });

  it("失败后换模型被拒绝", async () => {
    const fetchImpl = vi.fn(async (path: string) => {
      if (path === "/api/threads") return jsonResponse({ id: "t1" });
      return jsonResponse({}, 500);
    });
    const session = createNewThreadSession({ fetchImpl: fetchImpl as ThreadApiFetch });
    await expect(session.submit(submission())).rejects.toThrow();
    await expect(session.submit(submission({ modelRef: "m2" }))).rejects.toThrow("不能更换模型");
  });

  it("成功后 pending 清空（可开新会话）", async () => {
    let creates = 0;
    const fetchImpl = vi.fn(async (path: string) => {
      if (path === "/api/threads") {
        creates++;
        return jsonResponse({ id: `t${creates}` });
      }
      return jsonResponse({});
    });
    const session = createNewThreadSession({ fetchImpl: fetchImpl as ThreadApiFetch });
    await session.submit(submission());
    const second = await session.submit(submission({ text: "second" }));
    expect(creates).toBe(2); // 第二次是新会话
    expect(second.id).toBe("t2");
  });

  it("permissionMode 缺省与 auto 视为等价（可比对）", async () => {
    const fetchImpl = vi.fn(async (path: string) => {
      if (path === "/api/threads") return jsonResponse({ id: "t1" });
      return jsonResponse({}, 500);
    });
    const session = createNewThreadSession({ fetchImpl: fetchImpl as ThreadApiFetch });
    await expect(session.submit(submission({ permissionMode: undefined }))).rejects.toThrow();
    // auto 等价于缺省，不应触发「换内容」错误；应再次尝试 turn 并再失败
    await expect(session.submit(submission({ permissionMode: "auto" }))).rejects.not.toThrow(
      "不能更换模型或消息内容",
    );
  });
});
