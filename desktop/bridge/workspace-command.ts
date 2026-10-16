import { realpath, stat } from "node:fs/promises";
import { executeLocalCommand } from "../../lib/runtime/local-command";
import { buildSafeEnv } from "../../lib/runtime/safe-env";
import type { ExecResult } from "../../lib/runtime/types";
import type { WorkspaceRootStore } from "../storage/workspace-root-store";

export async function executeWorkspaceCommand(
  store: Pick<WorkspaceRootStore, "get">,
  input: { bindingId: string; command: string; timeoutMs: number; logCapBytes: number },
  signal?: AbortSignal,
): Promise<ExecResult & { workingDirectory: string }> {
  const binding = store.get(input.bindingId);
  if (!binding) throw new Error("本机没有此工作区绑定");
  const root = await realpath(binding.absolutePath);
  if (root !== binding.absolutePath || !(await stat(root)).isDirectory())
    throw new Error("本机工作区位置已变化");
  // 当前桌面发行版为 macOS。沙箱不可用时拒绝执行，不回退到无隔离命令。
  if (process.platform !== "darwin") throw new Error("当前平台尚未提供桌面命令沙箱");
  // 沙箱策略（macOS sandbox-exec，默认拒绝）：
  // - `process*` 保留：命令经 /bin/sh -c 执行，shell 与其调起的 node/pnpm 需要
  //   process-exec / process-fork 才能运行（这是命令执行本身的前提，不可去掉）。
  // - 网络只放 network-outbound：install/build 需要出网拉依赖；**不放 inbound**，
  //   避免 AI 生成的命令在宿主机上开监听端口对外暴露服务。若确有需要本地监听
  //   的构建/预览场景，应由调用方显式追加策略，不作为默认。
  // - 写权限仅限工作区 root 与 /dev/null；读权限限于系统只读路径 + root。
  const profile = `(version 1)
    (deny default)
    (allow process*)
    (allow sysctl-read)
    (allow mach-lookup)
    (allow file-read-metadata)
    (allow file-read* (literal "/"))
    (allow file-map-executable)
    (allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/dev") (subpath "/opt/homebrew") (subpath "/private/etc") (subpath "/private/var/db/dyld") (subpath ${JSON.stringify(root)}))
    (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))
    (allow network-outbound)`;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const command = `/usr/bin/sandbox-exec -p ${quote(profile)} /bin/sh -c ${quote(input.command)}`;
  const result = await executeLocalCommand({
    command,
    cwd: root,
    timeoutMs: Math.min(input.timeoutMs, 30000),
    logCapBytes: Math.min(input.logCapBytes, 10000),
    env: buildSafeEnv({ HOME: root, TMPDIR: root }),
    signal,
  });
  return { ...result, command: input.command, workingDirectory: root };
}
