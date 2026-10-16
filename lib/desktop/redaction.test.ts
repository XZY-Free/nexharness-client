import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  SENSITIVE_FIELD_NAMES,
  SENSITIVE_HEADERS,
  isSensitiveFieldName,
  isSensitiveHeader,
  redactCommandResult,
  redactFormField,
  sanitizeConsoleEntry,
  sanitizeDomSummary,
  sanitizeHeaders,
  sanitizeNetworkEntry,
  sanitizeUrl,
  truncateText,
} from "./redaction";

/**
 * 脱敏是数据出境（→ 模型 / 审计 / 日志）的最后一道闸。
 * 这些用例锁定「不泄露」契约——任何放宽都必须先改这里并说明理由。
 */
describe("isSensitiveFieldName", () => {
  it("覆盖 password/token/secret/authorization/apikey/银行卡/验证码变体", () => {
    for (const n of [
      "password",
      "user_password",
      "PASSWORD",
      "oldToken",
      "access_token",
      "clientSecret",
      "authorization",
      "api_key",
      "apiKey",
      "creditcard",
      "cardNumber",
      "cvv",
    ]) {
      expect(isSensitiveFieldName(n)).toBe(true);
    }
  });

  it("普通字段名不误伤", () => {
    for (const n of ["username", "email", "page", "limit", "q", "id", ""]) {
      expect(isSensitiveFieldName(n)).toBe(false);
    }
  });

  it("空值返回 false（不抛错）", () => {
    expect(isSensitiveFieldName("")).toBe(false);
  });
});

describe("isSensitiveHeader", () => {
  it("set-cookie/authorization/cookie/x-api-key 等判为敏感", () => {
    for (const h of ["Set-Cookie", "Authorization", "Cookie", "Proxy-Authorization", "X-Api-Key"]) {
      expect(isSensitiveHeader(h)).toBe(true);
    }
  });

  it("公开头不误伤", () => {
    for (const h of ["Content-Type", "Content-Length", "Accept", "User-Agent"]) {
      expect(isSensitiveHeader(h)).toBe(false);
    }
  });
});

describe("redactFormField — 密码值永不外泄", () => {
  it("value 恒为 [REDACTED]，不泄露原值", () => {
    const f = redactFormField("password", "password", "hunter2");
    expect(f.value).toBe("[REDACTED]");
    expect(JSON.stringify(f)).not.toContain("hunter2");
  });

  it("对非敏感字段同样返回 [REDACTED]（fail-safe）", () => {
    const f = redactFormField("username", "text", "alice");
    expect(f.value).toBe("[REDACTED]");
    expect(JSON.stringify(f)).not.toContain("alice");
  });

  it("保留 name / type 供调用方判定存在性", () => {
    const f = redactFormField("pwd", "password", "x");
    expect(f.name).toBe("pwd");
    expect(f.type).toBe("password");
  });
});

describe("truncateText", () => {
  it("未超上限原样返回", () => {
    expect(truncateText("abc", 10)).toBe("abc");
    expect(truncateText("abcde", 5)).toBe("abcde");
  });

  it("超限时追加 ... 且总长不超过上限", () => {
    const r = truncateText("abcdefghij", 8);
    expect(r.length).toBeLessThanOrEqual(8);
    expect(r.endsWith("...")).toBe(true);
  });

  it("上限 <= 3 时无法容纳省略号，只截断", () => {
    expect(truncateText("abcdef", 3)).toBe("abc");
    expect(truncateText("abcdef", 1)).toBe("a");
  });

  it("上限 <= 0 返回空串", () => {
    expect(truncateText("abc", 0)).toBe("");
    expect(truncateText("abc", -1)).toBe("");
  });
});

describe("sanitizeHeaders", () => {
  it("移除敏感头、保留公开头", () => {
    const out = sanitizeHeaders({
      "Set-Cookie": "session=abc",
      Authorization: "Bearer xyz",
      Cookie: "a=1",
      "Content-Type": "application/json",
      "Content-Length": "10",
    });
    expect(out).toEqual({ "Content-Type": "application/json", "Content-Length": "10" });
    expect(JSON.stringify(out)).not.toContain("xyz");
    expect(JSON.stringify(out)).not.toContain("session=abc");
  });

  it("不修改入参（返回新对象）", () => {
    const input = { Authorization: "x", "Content-Type": "y" };
    sanitizeHeaders(input);
    expect(input.Authorization).toBe("x");
  });

  it("大小写不敏感", () => {
    expect(sanitizeHeaders({ AUTHORIZATION: "x", COOKIE: "y" })).toEqual({});
  });
});

describe("sanitizeUrl — 移除敏感 query 参数", () => {
  it("移除 token/password 类参数，保留普通参数", () => {
    const out = sanitizeUrl("https://x/cb?token=secret123&page=2&password=pw");
    expect(out).toContain("page=2");
    expect(out).not.toContain("secret123");
    expect(out).not.toContain("pw");
  });

  it("大小写不敏感匹配参数名", () => {
    expect(sanitizeUrl("https://x/?AccessToken=abc")).not.toContain("abc");
  });

  it("无敏感参数时保持可解析", () => {
    const out = sanitizeUrl("https://x/a?b=1");
    expect(out).toContain("b=1");
  });

  it("非法 URL 原样返回（不抛错）", () => {
    expect(sanitizeUrl("not a url")).toBe("not a url");
    expect(sanitizeUrl("")).toBe("");
  });
});

describe("sanitizeConsoleEntry — 剥离 stack trace", () => {
  it("移除以 ' at ' 开头的 stack frame 行，保留首行消息", () => {
    const entry = {
      level: "error" as const,
      text: "TypeError: boom\n    at fn (https://internal.host/secret.js:10:5)\n    at other",
    };
    const out = sanitizeConsoleEntry(entry);
    expect(out.text).toBe("TypeError: boom");
    expect(out.text).not.toContain("internal.host");
  });

  it("无 stack trace 时保持原样", () => {
    const entry = { level: "log" as const, text: "hello" };
    expect(sanitizeConsoleEntry(entry).text).toBe("hello");
  });

  it("保留 level / url / lineNumber 等其它字段", () => {
    const out = sanitizeConsoleEntry({ level: "warning", text: "x", url: "u", lineNumber: 3 });
    expect(out.url).toBe("u");
    expect(out.lineNumber).toBe(3);
  });
});

describe("sanitizeNetworkEntry — body 强制置 null", () => {
  it("body 无论传什么都被置 null", () => {
    const out = sanitizeNetworkEntry({
      url: "https://x/a",
      method: "GET",
      status: 200,
      body: '{"secret":"data"}',
    });
    expect(out.body).toBeNull();
  });

  it("同时脱敏 URL 与 headers", () => {
    const out = sanitizeNetworkEntry({
      url: "https://x/?token=abc",
      method: "POST",
      status: 200,
      headers: { Authorization: "Bearer zzz", "Content-Type": "application/json" },
    });
    expect(out.url).not.toContain("abc");
    expect(out.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("不修改入参", () => {
    const input = { url: "https://x", method: "GET", status: 200, body: "keep" };
    sanitizeNetworkEntry(input);
    expect(input.body).toBe("keep");
  });
});

describe("sanitizeDomSummary", () => {
  it("移除 inline on* 事件处理器（双引号与单引号）", () => {
    const html = '<a onclick="steal()" onload=\'x()\' href="/a">go</a>';
    const out = sanitizeDomSummary(html);
    expect(out).not.toContain("steal()");
    expect(out).not.toContain("x()");
    expect(out).toContain('href="/a"');
  });

  it("移除 data: URI（可能携带凭证或注入负载）", () => {
    const out = sanitizeDomSummary('<img src="data:image/png;base64,AAAA">');
    expect(out).not.toContain("base64,AAAA");
  });

  it("无危险内容时保持原样", () => {
    expect(sanitizeDomSummary("<p>hello</p>")).toBe("<p>hello</p>");
  });
});

describe("redactCommandResult — 按命令分发", () => {
  it("null / undefined 原样返回", () => {
    expect(redactCommandResult("browser.getConsole", null)).toBeNull();
    expect(redactCommandResult("browser.getConsole", undefined)).toBeUndefined();
  });

  it("未知命令原样返回", () => {
    const r = { anything: 1 };
    expect(redactCommandResult("browser.unknown", r)).toBe(r);
  });

  it("getConsole：数组形状逐条脱敏 + 截断", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      level: "error" as const,
      text: `msg${i}\n    at fn (https://s/x.js:1:1)`,
    }));
    const out = redactCommandResult("browser.getConsole", entries) as typeof entries;
    expect(out.length).toBe(DEFAULT_LIMITS.maxConsoleEntries);
    expect(JSON.stringify(out)).not.toContain("at fn");
  });

  it("getConsole：{ entries } 形状同样脱敏且保留其它字段", () => {
    const out = redactCommandResult("browser.getConsole", {
      entries: [{ level: "log", text: "a\n    at z" }],
      total: 1,
    }) as { entries: unknown[]; total: number };
    expect(out.total).toBe(1);
    expect(JSON.stringify(out.entries)).not.toContain("at z");
  });

  it("getNetwork：body 置 null + 敏感头移除", () => {
    const out = redactCommandResult("browser.getNetwork", [
      {
        url: "https://x/?token=abc",
        method: "GET",
        status: 200,
        body: "leak",
        headers: { Authorization: "Bearer zzz" },
      },
    ]) as Array<{ body: unknown; url: string; headers?: Record<string, string> }>;
    expect(out[0]?.body).toBeNull();
    expect(JSON.stringify(out)).not.toContain("abc");
    expect(JSON.stringify(out)).not.toContain("zzz");
  });

  it("screenshot：字符串 → 引用占位（不返回原始字节）", () => {
    const out = redactCommandResult("browser.screenshot", "BASE64BYTES") as { ref: string };
    expect(out.ref).toBe("[REDACTED_RAW_BYTES]");
    expect(JSON.stringify(out)).not.toContain("BASE64BYTES");
  });

  it("screenshot：对象移除 data/base64/bytes 字段并加 ref", () => {
    const out = redactCommandResult("browser.screenshot", {
      format: "png",
      data: "AAA",
      base64: "BBB",
    }) as Record<string, unknown>;
    expect(out.ref).toBe("[REDACTED_RAW_BYTES]");
    expect(out.format).toBe("png");
    expect(JSON.stringify(out)).not.toContain("AAA");
    expect(JSON.stringify(out)).not.toContain("BBB");
  });

  it("snapshot：string / { html } / { text } 均做 DOM 脱敏 + 截断", () => {
    const s = redactCommandResult("browser.snapshot", '<a onclick="x()">y</a>');
    expect(String(s)).not.toContain("x()");
    const h = redactCommandResult("browser.snapshot", { html: '<i onload="z()">' }) as {
      html: string;
    };
    expect(h.html).not.toContain("z()");
    const t = redactCommandResult("browser.getAccessibilityTree", {
      text: '<b onclick="q()">',
    }) as { text: string };
    expect(t.text).not.toContain("q()");
  });

  it("getTabs：每个 tab 的 url 都脱敏敏感参数", () => {
    const out = redactCommandResult("browser.getTabs", {
      tabs: [{ url: "https://x/?token=abc&page=1" }],
      activeTabId: "t",
    }) as { tabs: Array<{ url: string }>; activeTabId: string };
    expect(out.activeTabId).toBe("t");
    expect(out.tabs[0]?.url).not.toContain("abc");
    expect(out.tabs[0]?.url).toContain("page=1");
  });
});

describe("常量与逻辑一致性（防漂移）", () => {
  it("SENSITIVE_FIELD_NAMES / SENSITIVE_HEADERS 中每项都被判定函数识别", () => {
    for (const n of SENSITIVE_FIELD_NAMES) expect(isSensitiveFieldName(n)).toBe(true);
    for (const h of SENSITIVE_HEADERS) expect(isSensitiveHeader(h)).toBe(true);
  });
});
