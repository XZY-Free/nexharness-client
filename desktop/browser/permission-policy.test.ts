import { describe, expect, it } from "vitest";
import {
  ALLOWED_PERMISSIONS,
  BLOCKED_SCHEMES,
  checkUrlSafety,
  decideCertificateError,
  decideDownload,
  decideExternalProtocol,
  decidePermission,
  decidePopup,
  isServerUrl,
} from "./permission-policy";

/**
 * 浏览器权限策略是桌面端的围栏（fail-closed）。
 * 这些用例锁定「默认拒绝」的安全契约——任何放宽都必须先改这里并说明理由。
 */
describe("decidePermission — 白名单外一律拒绝", () => {
  it("白名单权限 granted（fullscreen / display-capture / clipboard-sanitized-write）", () => {
    for (const p of ALLOWED_PERMISSIONS) {
      expect(decidePermission(p, "https://x")).toBe("granted");
    }
  });

  it("敏感权限默认拒绝（camera/mic/geolocation/notifications/clipboard-read）", () => {
    for (const p of [
      "media",
      "geolocation",
      "notifications",
      "midiSysex",
      "pointerLock",
      "clipboard-read",
      "speaker-selection",
      "window-management",
    ] as const) {
      expect(decidePermission(p, "https://x")).toBe("denied");
    }
  });

  it("unknown 权限拒绝（未知不豁免）", () => {
    expect(decidePermission("unknown", "https://x")).toBe("denied");
  });
});

describe("decidePopup — 全拒绝", () => {
  it("任何目标 URL 都拒绝弹窗（防恶意开窗）", () => {
    expect(decidePopup("https://trusted.example.com")).toBe("deny");
    expect(decidePopup("https://evil.com/phish")).toBe("deny");
    expect(decidePopup("")).toBe("deny");
  });
});

describe("decideCertificateError — 一律拒绝", () => {
  it("证书错误 fail-closed，不接受任何证书", () => {
    expect(decideCertificateError({}, "CERT_AUTHORITY_INVALID")).toBe("deny");
    expect(decideCertificateError({ issuer: "self" }, "ERR_CERT_DATE_INVALID")).toBe("deny");
  });
});

describe("decideExternalProtocol", () => {
  it("http/https 允许（属站内导航，非外部协议）", () => {
    expect(decideExternalProtocol("http://x/a")).toBe("allow");
    expect(decideExternalProtocol("https://x/a")).toBe("allow");
  });

  it("mailto/tel/自定义协议需用户确认（prompt）", () => {
    expect(decideExternalProtocol("mailto:a@b.com")).toBe("prompt");
    expect(decideExternalProtocol("tel:+8613800000000")).toBe("prompt");
    expect(decideExternalProtocol("myapp://open?id=1")).toBe("prompt");
  });

  it("非法 URL 拒绝", () => {
    expect(decideExternalProtocol("not a url")).toBe("deny");
    expect(decideExternalProtocol("")).toBe("deny");
  });
});

describe("checkUrlSafety", () => {
  it("http/https 判为 safe", () => {
    expect(checkUrlSafety("https://x/a")).toBe("safe");
    expect(checkUrlSafety("http://localhost:3000/")).toBe("safe");
  });

  it("危险 scheme 判为 blocked（file/data/blob/javascript）", () => {
    for (const u of [
      "file:///etc/passwd",
      "data:text/html,<script>1</script>",
      "blob:https://x/y",
      "javascript:alert(1)",
    ]) {
      expect(checkUrlSafety(u)).toBe("blocked");
    }
  });

  it("其他协议需确认（prompt）", () => {
    expect(checkUrlSafety("mailto:a@b.com")).toBe("prompt");
    expect(checkUrlSafety("ftp://x/f")).toBe("prompt");
  });

  it("非法 URL 判为 blocked", () => {
    expect(checkUrlSafety("ht!tp://bad")).toBe("blocked");
    expect(checkUrlSafety("")).toBe("blocked");
  });

  it("BLOCKED_SCHEMES 常量与判定一致（防常量与逻辑漂移）", () => {
    expect(BLOCKED_SCHEMES.has("file")).toBe(true);
    expect(BLOCKED_SCHEMES.has("javascript")).toBe(true);
  });
});

describe("decideDownload", () => {
  it("合法 URL 允许下载", () => {
    expect(decideDownload("https://x/file.zip")).toBe("allow");
  });

  it("非法 URL 拒绝", () => {
    expect(decideDownload("nonsense url")).toBe("deny");
    expect(decideDownload("")).toBe("deny");
  });
});

describe("isServerUrl", () => {
  const origins = ["https://nex.example.com", "http://localhost:3000"];

  it("精确匹配 origin 判为 Server URL", () => {
    expect(isServerUrl("https://nex.example.com/api/x", origins)).toBe(true);
    expect(isServerUrl("http://localhost:3000/chat", origins)).toBe(true);
  });

  it("白名单条目含 basePath 时仍按 origin 匹配", () => {
    expect(
      isServerUrl("https://nex.example.com/anything", ["https://nex.example.com/nexharness"]),
    ).toBe(true);
  });

  it("不同 origin / 非法 URL 判为 false", () => {
    expect(isServerUrl("https://evil.com/", origins)).toBe(false);
    expect(isServerUrl("https://nex.example.com.evil.com/", origins)).toBe(false);
    expect(isServerUrl("not a url", origins)).toBe(false);
    expect(isServerUrl("", origins)).toBe(false);
  });
});
