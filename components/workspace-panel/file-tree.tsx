import { apiFetch } from "@/lib/api-fetch";
import { ChevronDown, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WorkspaceFileIcon } from "./workspace-file-icon";

export const FILE_TREE_REFRESH_MS = 1500;

/** 连续失败后的轮询上限（退避目标）。 */
export const FILE_TREE_MAX_REFRESH_MS = 30_000;

/**
 * 下一次轮询间隔：成功 → 基础间隔；连续失败 → 指数退避（封顶 30s）。
 *
 * 文件树变化是低频事件，而 1.5s 轮询是这个面板里频率最高的请求。服务端异常/断网时
 * 若仍按 1.5s 空转，会持续制造失败请求；退避让故障期的请求量随时间收敛。
 */
export function nextRefreshDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return FILE_TREE_REFRESH_MS;
  const backoff = FILE_TREE_REFRESH_MS * 2 ** consecutiveFailures;
  return Math.min(backoff, FILE_TREE_MAX_REFRESH_MS);
}

/**
 * V5-B2：工作区文件树。
 *
 * 调用前台 list API（`/api/threads/{thread_id}/workspace`）拿扁平路径列表，前端构造树形结构。
 * 内部目录已在后端默认隐藏（listWorkspaceFiles skipInternal=true）。
 *
 * 文件节点点击 → onSelectPath(relPath)，由父级（WorkspacePanel file kind 分支）
 * 切换 FileViewer。选中状态由父级管理（selectedPath），便于外部程序化选中。
 */
type TreeNode = {
  name: string;
  path: string; // 完整相对路径
  isDir: boolean;
  children: Map<string, TreeNode>;
};

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = {
    name: "",
    path: "",
    isDir: true,
    children: new Map(),
  };
  for (const rel of files) {
    const segs = rel.split("/").filter(Boolean);
    let cur = root;
    segs.forEach((seg, i) => {
      const isLeaf = i === segs.length - 1;
      let next = cur.children.get(seg);
      if (!next) {
        next = {
          name: seg,
          path: segs.slice(0, i + 1).join("/"),
          isDir: !isLeaf,
          children: new Map(),
        };
        cur.children.set(seg, next);
      }
      cur = next;
    });
  }
  return root;
}

function sortTree(node: TreeNode) {
  const entries = Array.from(node.children.values());
  entries.sort((a, b) => {
    // 目录优先
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  node.children = new Map(entries.map((e) => [e.name, e]));
  for (const child of entries) sortTree(child);
}

function TreeRow({
  node,
  depth,
  selectedPath,
  expanded,
  toggle,
  onSelectPath,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  toggle: (path: string) => void;
  onSelectPath: (path: string) => void;
}) {
  const isOpen = expanded.has(node.path);
  const isSelected = selectedPath === node.path;

  if (node.isDir) {
    const children = Array.from(node.children.values());
    return (
      <div>
        <button
          type="button"
          onClick={() => toggle(node.path)}
          className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          aria-expanded={isOpen}
        >
          <ChevronDown
            aria-hidden="true"
            className={`size-3 shrink-0 text-foreground-subtle transition-transform ${
              isOpen ? "rotate-0" : "-rotate-90"
            }`}
          />
          {isOpen ? (
            <FolderOpen aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen ? (
          <div>
            {children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                expanded={expanded}
                toggle={toggle}
                onSelectPath={onSelectPath}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  // 文件节点
  return (
    <button
      type="button"
      onClick={() => onSelectPath(node.path)}
      className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors ${
        isSelected
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      style={{ paddingLeft: `${depth * 12 + 8 + 14}px` }}
      title={node.path}
    >
      <WorkspaceFileIcon name={node.name} className="size-4 shrink-0 text-foreground-subtle" />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

export function FileTree({
  threadId,
  selectedPath,
  onSelectPath,
}: {
  threadId: string;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
}) {
  const [files, setFiles] = useState<string[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // 初次打开立即加载；面板保持打开时静默轮询，同步 agent 后续写入的文件。
  // 轮询用「自调度 setTimeout」而非固定 setInterval：失败时指数退避，
  // 且页面切到后台（document.hidden）时跳过该轮，避免不可见时白跑请求。
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let hasLoaded = false;
    let failures = 0;
    let timer: number | undefined;
    setFiles(undefined);
    setError(null);

    const load = async (): Promise<boolean> => {
      if (cancelled || inFlight) return false;
      inFlight = true;
      try {
        const response = await apiFetch(`/api/threads/${threadId}/workspace`, {
          cache: "no-store",
        });
        const json = (await response.json()) as { threadId: string; files: string[] };
        if (cancelled) return false;
        if (response.ok && Array.isArray(json.files)) {
          const nextFiles = json.files;
          setFiles((prev) =>
            prev &&
            prev.length === nextFiles.length &&
            prev.every((file, index) => file === nextFiles[index])
              ? prev
              : nextFiles,
          );
          setError(null);
          hasLoaded = true;
          return true;
        }
        if (!hasLoaded) setError("无法加载文件列表");
        return false;
      } catch {
        if (!cancelled && !hasLoaded) setError("无法加载文件列表");
        return false;
      } finally {
        inFlight = false;
      }
    };

    const schedule = async () => {
      if (cancelled) return;
      // 页面不可见时不发请求，仅按基础间隔重新排队（回到前台立刻补齐）。
      const ok = document.hidden ? true : await load();
      failures = ok ? 0 : failures + 1;
      if (cancelled) return;
      timer = window.setTimeout(() => void schedule(), nextRefreshDelay(failures));
    };

    void schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [threadId]);

  // 默认展开顶层目录：首次拿到列表后展开根节点的所有目录，方便浏览。
  useEffect(() => {
    if (!files || files.length === 0) return;
    setExpanded((prev) => {
      if (prev.size > 0) return prev;
      const next = new Set(prev);
      for (const rel of files) {
        const segs = rel.split("/").filter(Boolean);
        const top = segs[0];
        if (segs.length > 1 && top) next.add(top);
      }
      return next;
    });
  }, [files]);

  const tree = useMemo(() => {
    if (!files) return null;
    const root = buildTree(files);
    sortTree(root);
    return root;
  }, [files]);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[12px] text-[var(--destructive)]">
        {error}
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-[12px] text-[var(--foreground-subtle)]">
        加载中…
      </div>
    );
  }

  if (tree.children.size === 0) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[12px] text-[var(--foreground-subtle)]">
        工作区暂无可查看文件
      </div>
    );
  }

  return (
    <nav className="min-h-0 flex-1 overflow-y-auto py-2" aria-label="工作区文件列表">
      {Array.from(tree.children.values()).map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={0}
          selectedPath={selectedPath}
          expanded={expanded}
          toggle={toggle}
          onSelectPath={onSelectPath}
        />
      ))}
    </nav>
  );
}
