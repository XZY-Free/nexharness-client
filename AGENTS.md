# AGENTS.md

NexHarness 客户端单体仓库：Web SPA（员工端对话 + Studio 管理后台）+ Electron 桌面客户端，对接 nexharness 服务端与 auth-center。本文件是 AI 协作的项目唯一指令源；`README.md` 面向人类开发者。

## 硬规则（优先级最高，冲突时以本节为准）

1. **代码是唯一事实基准。** 文档与代码冲突时改文档，不改代码行为；不要按文档猜测实现，先读代码。
2. **只维护本文件。** 不要创建 `CLAUDE.md`、`.codebuddy/`、`.cursorrules`、`.windsurfrules`、`.continue/` 等多份 AI 配置；Claude Code 会自动回退读取本文件。
3. **禁止提交密钥与本地配置。** 不提交 `.env*`、证书、签名材料；桌面签名变量（`CSC_LINK` 等）只从环境读取。
4. **禁止手改生成物。** `dist/`、`desktop/renderer-dist/`、`desktop/bundle/`、`desktop/package-app/`、`release/` 均为构建产物（已被 .gitignore 覆盖），不要编辑或提交。
5. **API 请求必须走 `apiFetch` / `apiPath`**（`lib/api-fetch.ts`），不要裸 `fetch("/api/...")`——basePath 不会自动拼接。
6. **新代码不要 import `next/*`。** 本仓已完全迁到 react-router（全仓零 `next/*` 引用）；历史上存在过的 shim 已移除。
7. **注释不写内部迭代代号与跨仓死链**（如故事号、阶段号、`docs/...` 外部文档路径）。描述当前行为即可。
8. **`lib/server-schema/` 是服务端 schema 的客户端投影**，不参与本仓迁移；不要在里面发明表结构。
9. **协议变更需同步两侧。** 改 `lib/desktop/` 协议类型时，同步检查 `desktop/bridge/`、`desktop/main/`、`desktop/preload/` 与渲染侧消费方。
10. **不要放宽安全默认值。** `desktop/runtime-config.json` 的 `allowInsecureRemoteOrigin` 默认 `false`（仅连接明文 http 私有部署时才置 `true`）；两个 `index.html` 的 CSP、`SECURE_WEB_PREFERENCES`、沙箱 profile、RPC 校验链都不得为「方便」而放宽。改安全边界模块必须同步更新其 `*.test.ts` 并说明理由。

## 技术栈与运行时

- TypeScript 5.9（strict + `noUncheckedIndexedAccess`），React 19.0.1，react-router-dom 7.1.1
- Vite 7.3.5（Web 与桌面 renderer 各一份配置），Tailwind CSS 4（`@tailwindcss/postcss`）
- Biome 1.9.4（lint + format 一体，2 空格缩进，行宽 100）
- Electron 43.4.1 + electron-builder 26（mac arm64）；better-sqlite3 13（桌面本地库，WAL）+ drizzle-orm 0.45（仅 `lib/server-schema/` 的服务端 schema 投影用，桌面 SQLite 不走 ORM）
- Node ≥ 22（CI 22 / Docker 24）；pnpm 10（Docker corepack 固定 10.32.1）
- 测试：vitest（纯逻辑单测）+ Playwright（E2E 冒烟）+ 真实 Electron 行为测试；见「改完如何验证」

## 命令（可直接复制执行）

```bash
pnpm install                        # 依赖（electron/better-sqlite3/esbuild 构建脚本已预放行）
pnpm dev                            # Web SPA dev server :5173（代理 /api /admin/api /studio/api /preview → :3210）
pnpm typecheck                      # tsc --noEmit（Web 侧）
pnpm lint                           # biome check .
pnpm build                          # typecheck + vite build（dist/）
pnpm test                           # vitest + 测试收集完整性校验
pnpm test:collect-check             # 单独校验测试收集（vitest 负载下会静默少收集）
pnpm test:e2e                       # Playwright 冒烟（需先 pnpm dev）
pnpm test:electron                  # 真实 Electron 行为测试（browser-controller 等）
pnpm exec tsc -p desktop/tsconfig.json --noEmit   # 桌面主进程/preload 类型检查
pnpm build:desktop-renderer         # 桌面渲染器构建（desktop/renderer-dist/）
pnpm build:desktop                  # renderer + main tsc + esbuild 打包
pnpm dev:desktop                    # 构建并启动 Electron
```

联调前提：nexharness 服务端（默认 `:3210`）与 auth-center（默认 `http://localhost:3101`）已启动。登录：`/login` → auth-center 门户 → `?ticket=` 回跳 → `POST /api/session/exchange`。

## 目录结构与关键模块

```
src/             Web SPA：main.tsx（入口，先兑换 ticket 再渲染）/ app.tsx（路由表，
                 Studio 路由 React.lazy 分包）/ routes/（chat、chat/:threadId、login、studio/*）/
                 lib/runtime-config.ts（auth-center 地址）/ styles/
components/      thread/（对话时间线：items/sidebar/input/command/catalog）/
                 studio/（管理后台面板与编辑器）/ ui/（基础组件）/ hooks/（数据 hooks）/
                 auth/（AuthGate）/ brand/ / desktop/ / workspace-panel/ / markdown.tsx
lib/             client/（Thread 投影层：store/reducer/SSE/client，Web 与 Desktop 共用）/
                 control-plane-client/（控制面 API 客户端 + DTO + 错误模型）/
                 desktop/（桥接协议 protocol/capabilities/commands/lease/approval/signing/redaction）/
                 identity/ + identity-client/（权限快照类型与纯函数评估）/
                 permission/（策略评估器）/ server-schema/（服务端 schema 投影）/
                 runtime/ / security/ / studio/ / thread/ / branding/ / api-fetch.ts / i18n.ts / error-codes.ts
desktop/         main/（主进程入口、窗口、IPC、origin 守卫、本地 renderer server）/
                 preload/ / renderer/（桌面渲染器，独立 vite 配置）/
                 bridge/（WebSocket 桥接生命周期、命令执行、设备身份、工作区命令沙箱）/
                 browser/（WebContentsView 控制、tab、debugger、下载联动、CDP、脱敏接线）/
                 storage/（SQLite、keychain、migrations）/ downloads/ / artifacts/ / updater/ / qa/ / auth/ / branding/
scripts/         build-desktop-renderer / build-desktop / rebuild-desktop-native /
                 check-test-collection / ensure-dist-cjs / run-electron-test
e2e/             smoke.mjs（Playwright）+ browser-controller.electron.cjs（真实 Electron）
deploy/          Dockerfile（多阶段，默认 NEX_BASE_PATH=/nexharness/）+ nginx.conf
```

## 代码风格与架构边界

- 应用内 API 请求统一走 `apiFetch` / `apiPath`；SSE 用 `lib/client/sse-client.ts`（fetch + ReadableStream，不用 EventSource）。
- `lib/client/` 是纯客户端投影层：不 import 服务端模块（db/node:crypto 等），保持浏览器 bundle 干净。
- `lib/desktop/` 是 Web 与桌面共享的协议与安全原语（纯逻辑，不依赖 electron）；electron 相关实现在 `desktop/` 下。
- **分包**：员工端主路径（`/chat`、`/login`、404）静态引入；Studio 后台（`/studio/*`）必须 `React.lazy` 动态引入——它是低频管理路径，不应进入员工首屏。
- **RPC 校验链（`desktop/bridge/bridge-client.ts`）顺序固定**：信封校验 → 审批分级 → 审批归属校验（`approvalScope`，缺 scope 即拒绝）→ nonce 去重（含过期清理）→ 分派执行。任何一步都不得绕过。
- 桌面主进程安全默认值（`desktop/main/window.ts`）：contextIsolation、sandbox、nodeIntegration=false、导航拦截只允许受信任 origin；`webSecurity` 不强制 https，明文 http 是否放行由 origin-guard 独立判定。
- 组件用函数组件 + hooks；样式用 Tailwind 类名；`components/ui/` 为 shadcn 风格基础组件。
- 提交信息遵循仓库既有惯例：`feat:` / `fix:` / `docs:` / `ci:` / `refactor:` 等前缀，中文描述。

## 禁止事项

- 不要 `git add -A`；按文件精确暂存。
- 不要随手改动构建配置（`biome.json`、`vite*.config.ts`、`desktop/electron-builder.yml`、CI）；确需改动前先读原配置确认影响面。
- 不要在 `lib/server-schema/` 新增表；不要直连数据库 Record 到页面（走 control-plane-client DTO）。
- 不要引入新的 UI 组件库或状态管理库；复用现有 `components/ui` + hooks。
- 不要另起测试框架（已用 vitest + Playwright + 真实 Electron）；新增用例放进现有体系。
- 不要把 `runtime-config.json` 的 `allowInsecureRemoteOrigin` 改成 `true` 提交——那会让所有打包默认放行任意公网 http origin。

## 常见任务怎么做

**加功能 / 新页面**
1. 新路由放 `src/routes/`，在 `src/app.tsx` 注册（studio 子路由挂在 `/studio` 下；**studio 页面用 `React.lazy`**，不要把管理后台拉进首屏）。
2. 数据获取用 `components/hooks/` 现有 hooks 或 `useApiData`；控制面操作用 `lib/control-plane-client`。
3. 共享投影逻辑放 `lib/client/`，不要写在组件里。

**修 bug**
1. 先读相关模块头注释与类型定义定位，再最小化修复。
2. 涉及 SSE / 代际（generation）逻辑时，读 `lib/client/thread-reducer.ts` 与 `sse-client.ts` 的约束注释——幂等与顺序规则不能破坏。
3. 改 `applyTransientDelta` 等流式热路径时注意：它每个 token 都执行，改动必须保持 `items` 按 `item_sequence` 升序、且 `itemsById` 同步（有回归用例）。

**重构**
1. 保持 `lib/client/`、`lib/desktop/` 的纯函数边界；跨端复用逻辑上移，electron 依赖留在 `desktop/`。
2. 重命名跨端符号时全局搜索（Web、renderer、main、preload 都会引用）。

**加测试**
纯逻辑（无 electron / 浏览器 / 服务端依赖）用 vitest：在模块旁建 `*.test.ts`，`pnpm test` 跑。
需要 DOM 的 React hooks 测试：文件首行加 `// @vitest-environment jsdom`（不打全局 jsdom）。
跨页面/需真实 DOM 的链路用 Playwright：放进 `e2e/`，`pnpm test:e2e` 跑。
真实 Electron 行为（view 生命周期 / Session 隔离等类型检查覆盖不到的）：`pnpm test:electron`。
改安全闸模块时同步更新其 `*.test.ts`（见「改完如何验证」）。

**改桌面协议 / 桥接**
1. 改 `lib/desktop/` 类型 → 同步 `desktop/bridge/`（命令执行、签名校验）→ `desktop/main/ipc-handlers.ts` → 渲染侧消费方。
2. 涉及 payload schema 时同步 `lib/desktop/commands.ts` 的 zod schema 与白名单。
3. `lib/desktop/rpc-envelope.ts` 的字段会参与 canonical 签名（`getEnvelopeSignPayload`）——新增字段必须两侧同改，且默认缺省时不得改变既有签名载荷。

## 改完如何验证

```bash
pnpm typecheck                                    # 必须通过
pnpm lint                                         # 必须通过
pnpm test                                         # 必须通过（vitest 单测 + 收集校验）
pnpm build                                        # 涉及 Web 侧时必须通过
pnpm exec tsc -p desktop/tsconfig.json --noEmit   # 涉及 desktop/ 或 lib/desktop/ 时必须通过
pnpm build:desktop-renderer                       # 涉及桌面渲染器时必须通过
pnpm test:electron                                # 改 browser-controller 时必须通过（类型检查发现不了事件是否真接上）
```

E2E 冒烟（需先起 `pnpm dev`；完整登录链路需服务端在线）：`pnpm test:e2e`。

改安全边界相关模块（`origin-guard`、`rpc-security`、`rpc-envelope`、`signing`、`redaction`、`permission-policy`、`approval`、`file-upload`、`screenshot`）时**必须同步更新对应 `*.test.ts`**——这些是防越权/防重放/防泄密的最后一道闸，放宽行为必须先改测试并说明理由。

CI（`.github/workflows/ci.yml`）在 push main / PR 时自动跑 typecheck / lint / test / build / build:desktop-renderer / 桌面 tsc / test:electron（不含 `pnpm build:desktop` 完整打包，本地需要时手动跑）。

## 关键环境变量速查

- 构建期：`NEX_BASE_PATH`（SPA base + API 前缀，默认 `/`；Docker 默认 `/nexharness/`）
- Web 运行期：`VITE_NEX_AUTH_CENTER_URL`（默认 `http://localhost:3101`）、`VITE_NEX_API_ORIGIN`（预留未用）
- 桌面：`NEX_SERVER_ORIGIN`（默认 `http://localhost:3000`，逗号分隔）、`NEX_BRIDGE_URL`（默认 `ws://localhost:3002`）、`NEX_AUTH_CENTER_URL`、`NEX_ALLOW_INSECURE_REMOTE_ORIGIN`（**默认关闭**；仅连接明文 http 私有部署时开启）、`NEX_E2E_*`（仅测试）
- 打包配置：`desktop/runtime-config.json` 随应用资源分发，可设 `serverOrigin` / `allowInsecureRemoteOrigin`；环境变量优先级高于它。
