// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStoredThreadDraft, useThreadDraft } from "./use-thread-draft";

/**
 * useThreadDraft 把输入草稿持久化到 sessionStorage（刷新/切换后不丢）。
 * 这些用例锁定：初始读取、写入/清空同步、切换 draftKey 重载。
 */
const PREFIX = "nexharness:draft:";

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("useThreadDraft", () => {
  it("初始为空串（无草稿）", () => {
    const { result } = renderHook(() => useThreadDraft("thread-1"));
    expect(result.current.text).toBe("");
  });

  it("初始读取已存在的草稿", () => {
    window.sessionStorage.setItem(`${PREFIX}thread-1`, "已有草稿");
    const { result } = renderHook(() => useThreadDraft("thread-1"));
    expect(result.current.text).toBe("已有草稿");
  });

  it("setText 写入 state 并持久化到 sessionStorage", () => {
    const { result } = renderHook(() => useThreadDraft("thread-1"));
    act(() => result.current.setText("hello"));
    expect(result.current.text).toBe("hello");
    expect(window.sessionStorage.getItem(`${PREFIX}thread-1`)).toBe("hello");
  });

  it('setText("") 清空持久化（移除 key，不留空串）', () => {
    const { result } = renderHook(() => useThreadDraft("thread-1"));
    act(() => result.current.setText("something"));
    act(() => result.current.setText(""));
    expect(result.current.text).toBe("");
    expect(window.sessionStorage.getItem(`${PREFIX}thread-1`)).toBeNull();
  });

  it("clear 清空 state 与存储", () => {
    const { result } = renderHook(() => useThreadDraft("thread-1"));
    act(() => result.current.setText("draft"));
    act(() => result.current.clear());
    expect(result.current.text).toBe("");
    expect(window.sessionStorage.getItem(`${PREFIX}thread-1`)).toBeNull();
  });

  it("draftKey 变化时重载对应草稿（不串号）", () => {
    window.sessionStorage.setItem(`${PREFIX}a`, "A");
    window.sessionStorage.setItem(`${PREFIX}b`, "B");
    const { result, rerender } = renderHook(({ key }) => useThreadDraft(key), {
      initialProps: { key: "a" },
    });
    expect(result.current.text).toBe("A");
    rerender({ key: "b" });
    expect(result.current.text).toBe("B");
  });

  it("不同 draftKey 的写入互不影响", () => {
    window.sessionStorage.setItem(`${PREFIX}other`, "keep");
    const { result } = renderHook(() => useThreadDraft("mine"));
    act(() => result.current.setText("x"));
    expect(window.sessionStorage.getItem(`${PREFIX}other`)).toBe("keep");
  });
});

describe("clearStoredThreadDraft", () => {
  it("移除指定 key 的草稿", () => {
    window.sessionStorage.setItem(`${PREFIX}k`, "v");
    clearStoredThreadDraft("k");
    expect(window.sessionStorage.getItem(`${PREFIX}k`)).toBeNull();
  });

  it("无该 key 时不抛错（幂等）", () => {
    expect(() => clearStoredThreadDraft("ghost")).not.toThrow();
  });
});
