import { describe, expect, it } from "vitest";
import {
  BLOCKED_QA_PERMISSIONS,
  QA_READONLY_INJECTION,
  decideQaCertificateError,
  decideQaDownload,
  decideQaExternalProtocol,
  decideQaNavigation,
  decideQaPermission,
  decideQaPopup,
  isReadOnlyRequestMethod,
} from "./qa-policy";

/**
 * QA 沙盒策略是「不可见 QA 页绝不产生副作用」的闸门（全 fail-closed）。
 * 这些用例锁定：下载/权限/弹窗/外部协议/证书全拒，导航只 http/https，方法只读。
 */
describe("一律拒绝类决策", () => {
  it("下载始终 deny（QA 不产生本机文件）", () => {
    expect(decideQaDownload()).toBe("deny");
  });

  it("任何权限类型都 denied（含通常允许的 fullscreen/display-capture）", () => {
    for (const p of [...BLOCKED_QA_PERMISSIONS, "someFuturePermission"]) {
      expect(decideQaPermission(p)).toBe("denied");
    }
  });

  it("弹窗始终 deny", () => {
    expect(decideQaPopup()).toBe("deny");
  });

  it("外部协议始终 deny（防 mailto/custom scheme 触发本机应用）", () => {
    expect(decideQaExternalProtocol()).toBe("deny");
  });

  it("证书错误始终 deny（不接受自签名/过期证书）", () => {
    expect(decideQaCertificateError()).toBe("deny");
  });
});

describe("decideQaNavigation — 只允许 http/https", () => {
  it("http/https 允许", () => {
    expect(decideQaNavigation("http://x/a")).toBe("allow");
    expect(decideQaNavigation("https://x/a")).toBe("allow");
  });

  it("危险 scheme 拒绝（file/data/javascript/blob/ftp/about）", () => {
    for (const u of [
      "file:///etc/passwd",
      "data:text/html,<script>1</script>",
      "javascript:alert(1)",
      "blob:https://x/y",
      "ftp://x/f",
      "about:blank",
    ]) {
      expect(decideQaNavigation(u)).toBe("deny");
    }
  });

  it("空值 / 非字符串 / 非法 URL 拒绝", () => {
    expect(decideQaNavigation("")).toBe("deny");
    expect(decideQaNavigation("not a url")).toBe("deny");
    expect(decideQaNavigation(undefined as unknown as string)).toBe("deny");
    expect(decideQaNavigation(null as unknown as string)).toBe("deny");
  });
});

describe("isReadOnlyRequestMethod — 只读方法白名单", () => {
  it("GET/HEAD/OPTIONS 放行（大小写不敏感）", () => {
    for (const m of ["GET", "get", "Get", "HEAD", "head", "OPTIONS", "options"]) {
      expect(isReadOnlyRequestMethod(m)).toBe(true);
    }
  });

  it("写方法阻断（POST/PUT/DELETE/PATCH）", () => {
    for (const m of ["POST", "put", "DELETE", "patch", "TRACE", "CONNECT"]) {
      expect(isReadOnlyRequestMethod(m)).toBe(false);
    }
  });

  it("空 / 未知方法阻断（fail-closed）", () => {
    expect(isReadOnlyRequestMethod("")).toBe(false);
    expect(isReadOnlyRequestMethod("WEIRD")).toBe(false);
  });
});

describe("BLOCKED_QA_PERMISSIONS 常量", () => {
  it("包含常见的敏感权限（media/geolocation/notifications/display-capture）", () => {
    expect(BLOCKED_QA_PERMISSIONS).toContain("media");
    expect(BLOCKED_QA_PERMISSIONS).toContain("geolocation");
    expect(BLOCKED_QA_PERMISSIONS).toContain("notifications");
    expect(BLOCKED_QA_PERMISSIONS).toContain("display-capture");
  });

  it("无重复项", () => {
    expect(new Set(BLOCKED_QA_PERMISSIONS).size).toBe(BLOCKED_QA_PERMISSIONS.length);
  });
});

describe("QA_READONLY_INJECTION", () => {
  it("注入脚本阻止表单提交与 window.open", () => {
    expect(QA_READONLY_INJECTION).toContain("submit");
    expect(QA_READONLY_INJECTION).toContain("preventDefault");
    expect(QA_READONLY_INJECTION).toContain("window.open");
  });

  it("是自执行函数（加载即生效）", () => {
    expect(QA_READONLY_INJECTION).toContain("function()");
  });
});
