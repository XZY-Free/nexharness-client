/**
 * V4 Phase D-1：Markdown 渲染 + 代码块语法高亮（shiki）+ 复制按钮。
 *
 * shiki 用 TextMate grammar + VS Code 主题逐 token 精确着色，精度与视觉现代感优于
 * rehype-highlight/highlight.js 的正则匹配——代码块是「AI 写代码」工具的高频核心展示，
 * 故方案定为必须用 shiki（非备选）。
 *
 * shiki 异步初始化（加载语言 grammar），故 CodeBlock 用 effect 等 highlighter 就绪后
 * codeToHtml 转 HTML；未就绪时先渲染纯文本 fallback，就绪后替换为高亮 HTML。
 * 模块级单例 highlighter（createHighlighterCore），全应用共享一份，语言按需预加载常用集。
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type HighlighterCore, createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { Icon } from "./icons";

/**
 * 预加载语言（**显式注册**，不引入全量 grammar）。
 *
 * 此前用 `getSingletonHighlighter`（shiki 主入口）会把**全部**语言 grammar 拉进构建图，
 * 产出 309 chunk / 12MB（含 emacs-lisp 772K、cpp 768K、wolfram 260K 等冷门语言）。
 * 现改为 createHighlighterCore + 逐语言动态 import：只有下列语言的 chunk 会被产出。
 *
 * 未列出的语言 → 不传 lang 给 codeToHtml → 纯文本 fallback（与原「未预加载按需加载」
 * 相比，代价是不再自动支持长尾语言；如需扩展，在此对象补一项即可）。
 */
const LANG_IMPORTS = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
} as const;

type PreloadLang = keyof typeof LANG_IMPORTS;

const PRELOAD_LANGS = Object.keys(LANG_IMPORTS) as PreloadLang[];

/**
 * 语言别名（markdown 里常见的写法差异）→ shiki 原生 langAlias。
 * 命中别名即视为已注册语言；未命中且不在预置集内 → fallback 纯文本。
 */
const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
};

const THEME = "github-dark";

let highlighterPromise: Promise<HighlighterCore> | null = null;

/** 模块级单例 highlighter：首次调用加载预置语言 + 主题，后续共享。 */
function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [import("shiki/themes/github-dark.mjs")],
      // 并行加载所有预置语言
      langs: PRELOAD_LANGS.map((lang) => LANG_IMPORTS[lang]()),
      langAlias: LANG_ALIAS,
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
  }
  return highlighterPromise;
}

/** 把 markdown 里写的语言名归一为已注册语言；不在预置集内返回 null（走 fallback）。 */
function normalizeLang(raw: string | null): PreloadLang | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  // 别名先归一（js→javascript 等），再确认是否在预置集内
  const canonical = LANG_ALIAS[lower] ?? lower;
  return canonical in LANG_IMPORTS ? (canonical as PreloadLang) : null;
}

/** 从 code 元素 className 提取语言（react-markdown 给的 language-xxx）。 */
function langFromClassName(className?: string): string | null {
  const m = /language-(\w+)/.exec(className ?? "");
  return m ? (m[1] ?? null) : null;
}

/** 从 ReactNode children 提取纯文本（复制 + shiki 输入用）。 */
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    // biome-ignore lint/suspicious/noExplicitAny: React element props 动态访问
    return extractText((node as any).props?.children);
  }
  return "";
}

/** 块级代码块：shiki 高亮 + 复制按钮 + 语言标签。 */
export function CodeBlock({
  className,
  children,
  plain = false,
}: { className?: string; children?: ReactNode; plain?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const lang = langFromClassName(className);
  const codeText = useMemo(() => extractText(children), [children]);

  // shiki 异步：highlighter 就绪后 codeToHtml 生成高亮 HTML。未就绪时 html=null 走纯文本 fallback。
  // 用 ref 记录上一次实际发起过高亮请求的 codeText+lang，避免 Strict Mode 或父组件重渲染导致重复 setState。
  const requestedRef = useRef<{ codeText: string; lang: string | null } | null>(null);
  useEffect(() => {
    if (plain) return;
    const prev = requestedRef.current;
    if (prev && prev.codeText === codeText && prev.lang === lang) return;
    requestedRef.current = { codeText, lang };

    let cancelled = false;
    // 语言归一：不在预置集内 → null（走纯文本 fallback，不再触发全量 grammar 加载）
    const resolvedLang = normalizeLang(lang);
    getHighlighter()
      .then((hl) => {
        if (cancelled) return;
        try {
          setHtml(
            resolvedLang ? hl.codeToHtml(codeText, { lang: resolvedLang, theme: THEME }) : null,
          );
        } catch {
          setHtml(null); // 高亮失败 → fallback 纯文本
        }
      })
      .catch(() => {
        // highlighter 初始化失败 → fallback 纯文本（不阻塞阅读）
      });
    return () => {
      cancelled = true;
    };
  }, [codeText, lang, plain]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非 HTTPS / 权限拒绝），静默
    }
  }

  return (
    <div className={plain ? "ha-code-block group relative" : "group relative my-3"}>
      {/* 语言标签 */}
      {lang ? (
        <span className="absolute right-12 top-2 z-10 text-[11px] text-[var(--foreground-subtle)]">
          {lang}
        </span>
      ) : null}
      {/* 复制按钮 */}
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded text-[var(--foreground-subtle)] opacity-0 transition hover:bg-[var(--muted)] hover:text-[var(--foreground)] group-hover:opacity-100 focus-visible:opacity-100"
        title="复制代码"
        aria-label={copied ? "已复制" : "复制代码"}
      >
        <Icon.copy size={13} />
      </button>
      {/* shiki 高亮 HTML（已含 github-dark 主题着色）；未就绪时纯文本 fallback */}
      {html && !plain ? (
        <div
          className="shiki-block overflow-x-auto rounded-[var(--radius-md)] text-[13px] leading-6"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki codeToHtml 输出受信任的语法高亮 HTML
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto rounded-[var(--radius-md)] bg-[var(--muted)] p-3 text-[13px] leading-6">
          <code className={`${className ?? ""} bg-transparent p-0 text-inherit text-[13px]`}>
            {children}
          </code>
        </pre>
      )}
      {copied ? (
        <span className="absolute right-2 top-9 z-10 text-[11px] text-[var(--success)]">
          已复制
        </span>
      ) : null}
    </div>
  );
}

/** react-markdown 块级 pre 渲染器：从 <code> 元素提取 className/children 交给 CodeBlock。 */
function PreRenderer({ children }: { children?: ReactNode }) {
  // biome-ignore lint/suspicious/noExplicitAny: react-markdown pre props 动态
  const codeEl = children as any;
  const codeProps = codeEl?.props ?? {};
  return <CodeBlock className={codeProps.className}>{codeProps.children}</CodeBlock>;
}

/** react-markdown 行内 code 渲染器。块级 code 已被 pre 覆盖，这里只处理行内 code。 */
function InlineCodeRenderer({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <code
      className={`${className ?? ""} rounded bg-[var(--muted)] px-1 py-0.5 text-[13px]`}
      {...rest}
    >
      {children}
    </code>
  );
}

// 组件引用必须在渲染间保持稳定；若把 renderers 定义在 Markdown 内部，
// 每次渲染都会生成新的函数引用，导致 React 不断 unmount/remount CodeBlock，
// 配合 shiki 异步 setState 会触发 Maximum update depth exceeded。
const MARKDOWN_COMPONENTS = {
  pre: PreRenderer,
  code: InlineCodeRenderer,
};

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
}
