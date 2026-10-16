# nexharness-client

NexHarness 客户端单体仓库：**Web SPA**（员工端对话 + Studio 管理后台）与 **Electron 桌面客户端**，对接 nexharness 服务端与 auth-center 认证中心。私有内部项目，未发布开源协议。

## 环境要求

- Node.js ≥ 22（CI 用 22，Docker 构建用 24）
- pnpm 10（CI 与 Docker 均为 10；Docker 内由 corepack 固定 10.32.1）
- macOS（桌面打包仅配置了 mac arm64 target）

## 快速开始（Web SPA）

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

dev server 将 `/api`、`/admin/api`、`/studio/api`、`/preview` 代理到 nexharness 服务端（默认 `http://localhost:3210`）。

联调前提：

1. nexharness 服务端已启动（默认 `:3210`）。
2. auth-center 已启动（默认 `http://localhost:3101`）。
3. 登录流程：访问 `/login` → 302 跳转 auth-center 门户 → 登录完成后带 `?ticket=` 回跳 → SPA 启动时 `POST /api/session/exchange` 兑换会话 cookie。

## 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | Web SPA dev server（:5173） |
| `pnpm build` | typecheck + 静态产物（`dist/`） |
| `pnpm typecheck` | `tsc --noEmit`（Web 侧） |
| `pnpm lint` / `pnpm lint:fix` | Biome 检查 / 自动修复 |
| `pnpm test` / `pnpm test:watch` | 单元测试（vitest，纯逻辑模块） |
| `pnpm test:e2e` | E2E 冒烟（Playwright；需先起 `pnpm dev`） |
| `pnpm format` | Biome 格式化 |
| `pnpm preview` | 预览构建产物 |
| `pnpm build:desktop-renderer` | 桌面渲染器构建（`desktop/renderer-dist/`） |
| `pnpm build:desktop` | renderer + 主进程 tsc + esbuild 打包（`desktop/package-app/`） |
| `pnpm rebuild:desktop-native` | better-sqlite3 按 Electron ABI 重编译 |
| `pnpm dev:desktop` | 构建并启动 Electron |
| `pnpm package:desktop` | electron-builder 打包（mac arm64，未签名） |
| `pnpm package:desktop:signed` | 签名 + 公证打包（需配置签名环境变量，见下） |

桌面首次 `pnpm install` 无需手动放行构建脚本：`package.json` 的 `pnpm.onlyBuiltDependencies` 已包含 `electron`、`better-sqlite3`、`esbuild`。

## 桌面端

- 主进程入口 `desktop/main/index.ts`；桌面页面由本机 loopback server 提供（`desktop/renderer/`），API/SSE 走配置的 Server origin。
- 本地数据库：SQLite（`userData/desktop.sqlite`，migrations 在 `desktop/storage/migrations/`）；设备身份存系统 keychain（Electron safeStorage）。
- 自动更新：electron-updater，更新源默认 `https://updates.nexharness.com/mac`（`desktop/electron-builder.yml` 的 `publish` 配置）。
- 签名打包需要的环境变量：`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`。

## 部署（Web SPA）

```bash
docker build -f deploy/Dockerfile -t nexharness-client:dev .
```

- 多阶段构建：node:24-alpine 装依赖 → `pnpm build` → alpine:3.19 + nginx 运行静态产物。
- 默认子路径部署 `/nexharness/`（构建期 `NEX_BASE_PATH`，与 nginx 配置、apiPath 注入源一致）；根路径部署用 `--build-arg NEX_BASE_PATH=/` 并按 `deploy/nginx.conf` 内注释调整 location 前缀。
- nginx 提供 `/healthz` 探活；同域反代 API 的示例配置在 `deploy/nginx.conf` 注释中，按拓扑启用。

## 配置与环境变量

Web SPA（构建期 / 运行期）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEX_BASE_PATH` | `/` | 构建期：SPA base 与 API 路径前缀（Docker 默认 `/nexharness/`） |
| `VITE_NEX_AUTH_CENTER_URL` | `http://localhost:3101` | auth-center 地址（登录跳转入口） |
| `VITE_NEX_API_ORIGIN` | — | 预留：独立部署时 API 绝对地址；当前同源/代理模式不使用 |

桌面端（主进程）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NEX_SERVER_ORIGIN` | `http://localhost:3000` | 受信任 Server origin，逗号分隔可配多个 |
| `NEX_BRIDGE_URL` | `ws://localhost:3002` | Agent Bridge WebSocket 地址 |
| `NEX_AUTH_CENTER_URL` | — | auth-center origin（认证窗口放行用） |
| `NEX_ALLOW_INSECURE_REMOTE_ORIGIN` | — | 置 `1` 放行公网 http origin（私有部署） |
| `NEX_E2E_LOG_FILE` / `NEX_E2E_DISABLE_SINGLE_INSTANCE` | — | E2E 诊断日志 / 允许多实例（仅测试） |

密钥约束：不提交任何 `.env*` 与密钥；桌面签名材料只从环境变量读取；设备私钥存系统 keychain。

## 项目结构

```
src/                 Web SPA：入口（main.tsx/app.tsx）、路由表（routes/）、
                     next→react-router shim（shims/）、运行时配置、样式
components/          UI 组件：thread（对话时间线）/ studio（管理后台）/ ui（基础组件）/
                     hooks（数据 hooks）/ auth / brand / desktop / workspace-panel
lib/                 共享库：client（Thread 投影层）/ control-plane-client（控制面 API）/
                     desktop（桥接协议与安全）/ identity（权限快照）/ permission（策略评估）/
                     persistence/schema（服务端 schema 投影）/ runtime / security / studio /
                     api-fetch / i18n / utils
desktop/             Electron：main（主进程）/ preload / renderer / bridge / browser /
                     storage / downloads / artifacts / updater / qa / auth / branding
scripts/             桌面构建脚本（renderer 构建 / main esbuild 打包 / native 重编译）
deploy/              Dockerfile + nginx.conf
public/              品牌资产与 theme-init.js
```

## 代码规范

- TypeScript strict（含 `noUncheckedIndexedAccess`）；Biome 统一 lint + format（2 空格缩进，行宽 100）。
- 应用内 API 请求统一走 `lib/api-fetch.ts` 的 `apiFetch` / `apiPath`（自动拼 basePath），不要裸 `fetch("/api/...")`。
- `next/link`、`next/navigation` 通过 alias 映射到 react-router shim；新代码直接用 react-router API。
- CI（`.github/workflows/ci.yml`，push main / PR）：`pnpm typecheck` → `pnpm lint` → `pnpm test` → `pnpm build` → `pnpm build:desktop-renderer` → 桌面 `tsc`。

## 测试

- **单元测试（vitest）**：`pnpm test`。覆盖不依赖 electron / 浏览器 / 服务端的纯逻辑——origin 守卫、RPC 信封安全校验、ed25519 签名、脱敏、CDP 输入映射。新增此类模块时请在旁边加 `*.test.ts`。
- **E2E 冒烟（Playwright）**：先起 dev server（`pnpm dev`），再 `pnpm test:e2e`。覆盖 SPA 加载、门禁拦截、404 视图、无未捕获异常。完整登录后链路需 nexharness 服务端（:3210）与 auth-center 在线。

AI 协作请读 `AGENTS.md`。
