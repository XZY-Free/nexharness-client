import { describe, expect, it, vi } from "vitest";
import { createStudioApiClient } from "./studio";

/**
 * Studio API Client：让 Studio 页面走与 control-plane 同一套传输层。
 * 这些用例锁定：端点路径、URL 编码、withSync 查询、错误模型透传。
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetcher: typeof fetch) {
  return createStudioApiClient({ baseUrl: "", headers: () => ({}), fetcher });
}

describe("createStudioApiClient — 端点路径", () => {
  it("listSkills 不带 withSync", async () => {
    const fetcher = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    await makeClient(fetcher).listSkills();
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "/studio/api/skills",
    );
  });

  it("listSkills({withSync:true}) 加 ?withSync=1", async () => {
    const fetcher = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    await makeClient(fetcher).listSkills({ withSync: true });
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "/studio/api/skills?withSync=1",
    );
  });

  it("getSkill 对 id 做 URL 编码（防路径注入）", async () => {
    const fetcher = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    await makeClient(fetcher).getSkill("a/b?c");
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "/studio/api/skills/a%2Fb%3Fc",
    );
  });

  it("listSkillVersions 路径正确", async () => {
    const fetcher = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch;
    await makeClient(fetcher).listSkillVersions("sk-1");
    expect((fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "/studio/api/skills/sk-1/versions",
    );
  });

  it("governance / permission-rules / audit / agents 路径", async () => {
    const fetcher = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    const c = makeClient(fetcher);
    await c.getGovernance();
    await c.getPermissionRules();
    await c.getAudit();
    await c.getAgentCount();
    const calls = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls.map((x) => x[0]);
    expect(calls).toEqual([
      "/studio/api/governance",
      "/studio/api/permission-rules",
      "/studio/api/audit",
      "/admin/api/agents",
    ]);
  });
});

describe("createStudioApiClient — 错误经统一模型抛出", () => {
  it("404 envelope → 抛 ControlPlaneRequestError（含 code/status）", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "不存在",
            request_id: "r1",
            retryable: false,
          },
        },
        404,
      ),
    ) as unknown as typeof fetch;
    await expect(makeClient(fetcher).getSkill("x")).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      status: 404,
      requestId: "r1",
    });
  });

  it("成功返回解析后的 body", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ total: 7 })) as unknown as typeof fetch;
    await expect(makeClient(fetcher).getAgentCount()).resolves.toEqual({ total: 7 });
  });
});
