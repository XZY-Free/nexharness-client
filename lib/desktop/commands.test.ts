import { describe, expect, it } from "vitest";
import {
  ACTION_COMMANDS,
  ALLOWED_COMMANDS,
  COMMAND_TO_TOOL,
  READ_COMMANDS,
  TOOL_TO_COMMAND,
  isActionCommand,
  isAllowedCommand,
  isReadCommand,
  toolToCommand,
  validateCommandPayload,
} from "./commands";

/**
 * 命令白名单是「AI 能对浏览器做什么」的第一道闸。
 * 这些用例锁定：未知命令一律拒绝、读/写分类正确、payload schema 拒绝注入、工具名映射双向一致。
 */
describe("白名单分类", () => {
  it("READ_COMMANDS 全是读命令，不是 action", () => {
    for (const c of READ_COMMANDS) {
      expect(isReadCommand(c)).toBe(true);
      expect(isActionCommand(c)).toBe(false);
      expect(isAllowedCommand(c)).toBe(true);
    }
  });

  it("ACTION_COMMANDS 全是 action，不是 read", () => {
    for (const c of ACTION_COMMANDS) {
      expect(isActionCommand(c)).toBe(true);
      expect(isReadCommand(c)).toBe(false);
      expect(isAllowedCommand(c)).toBe(true);
    }
  });

  it("read 与 action 集合不重叠", () => {
    const overlap = READ_COMMANDS.filter((c) => (ACTION_COMMANDS as readonly string[]).includes(c));
    expect(overlap).toEqual([]);
  });

  it("ALLOWED_COMMANDS = read + action（无遗漏）", () => {
    expect(ALLOWED_COMMANDS.length).toBe(READ_COMMANDS.length + ACTION_COMMANDS.length);
  });

  it("未知命令一律拒绝", () => {
    for (const c of ["browser.hack", "", "DELETE FROM", "browser.getTabsX", "browser."]) {
      expect(isAllowedCommand(c)).toBe(false);
      expect(isReadCommand(c)).toBe(false);
      expect(isActionCommand(c)).toBe(false);
    }
  });
});

describe("toolToCommand — 工具名映射", () => {
  it("已知工具名映射到合法命令", () => {
    expect(toolToCommand("browserGetTabs")).toBe("browser.getTabs");
    expect(toolToCommand("shellExecute")).toBe("workspace.execute");
  });

  it("未知工具名返回 null（不猜测）", () => {
    expect(toolToCommand("browserHack")).toBeNull();
    expect(toolToCommand("")).toBeNull();
  });

  it("双向映射一致：TOOL_TO_COMMAND 与 COMMAND_TO_TOOL 互逆", () => {
    for (const [tool, cmd] of Object.entries(TOOL_TO_COMMAND)) {
      expect(COMMAND_TO_TOOL[cmd]).toBe(tool);
    }
  });

  it("所有映射目标都是白名单命令", () => {
    for (const cmd of Object.values(TOOL_TO_COMMAND)) {
      expect(isAllowedCommand(cmd)).toBe(true);
    }
  });
});

describe("validateCommandPayload — schema 校验", () => {
  it("未知命令返回 unknown_command", () => {
    const r = validateCommandPayload("browser.hack", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("unknown_command");
  });

  it("合法 payload 通过并返回脱敏后的 data", () => {
    const r = validateCommandPayload("browser.getTabs", { threadId: "t1" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.payload as { threadId: string }).threadId).toBe("t1");
  });

  it("缺必填字段返回 invalid_payload", () => {
    const r = validateCommandPayload("browser.getTabs", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_payload");
  });

  it("字段类型错误返回 invalid_payload", () => {
    expect(validateCommandPayload("browser.getTabs", { threadId: 123 }).ok).toBe(false);
    expect(validateCommandPayload("browser.getTabs", { threadId: "" }).ok).toBe(false);
  });

  it("非对象 payload 返回 invalid_payload", () => {
    for (const p of [null, undefined, "str", 42, []]) {
      expect(validateCommandPayload("browser.getTabs", p).ok).toBe(false);
    }
  });

  it("navigate 需要 threadId + tabId + url 三者", () => {
    expect(
      validateCommandPayload("browser.navigate", { threadId: "t", tabId: "tab", url: "https://x" })
        .ok,
    ).toBe(true);
    expect(validateCommandPayload("browser.navigate", { threadId: "t", url: "https://x" }).ok).toBe(
      false,
    );
    expect(validateCommandPayload("browser.navigate", { threadId: "t", tabId: "tab" }).ok).toBe(
      false,
    );
  });

  it("strict schema 拒绝多余字段（防注入）", () => {
    // workspace.execute 是 strict 的
    const r = validateCommandPayload("workspace.execute", {
      threadId: "t",
      bindingId: "b",
      command: "ls",
      timeoutMs: 1000,
      logCapBytes: 100,
      injected: "evil",
    });
    expect(r.ok).toBe(false);
  });

  it("越界数值被拒（timeoutMs 上下限）", () => {
    const base = {
      threadId: "t",
      bindingId: "b",
      command: "ls",
      logCapBytes: 100,
    };
    expect(validateCommandPayload("workspace.execute", { ...base, timeoutMs: 50 }).ok).toBe(false);
    expect(validateCommandPayload("workspace.execute", { ...base, timeoutMs: 99999 }).ok).toBe(
      false,
    );
    expect(validateCommandPayload("workspace.execute", { ...base, timeoutMs: 1000 }).ok).toBe(true);
  });
});
