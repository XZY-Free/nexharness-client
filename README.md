# nexharness-client

NexHarness 客户端仓库（阶段③ 拆分自 nexharness）：**Web SPA（Vite + React + react-router） + Desktop 客户端 + 客户端 SDK**。

## 结构

```
src/                  Web SPA：入口 / 路由 / next→react-router shim / 运行时配置
components/           UI 组件（原样搬自 nexharness，含 thread / studio / ui / brand / desktop）
lib/                  客户端安全库子集（client / api-fetch / utils / i18n / control-plane-client /
                      desktop 协议 / identity-client 纯函数 / 协议词表等）
desktop/              Electron 客户端（main / preload / renderer / bridge / browser / …）
scripts/              桌面构建脚本（renderer vite 构建 / main esbuild 打包 / native 重编译）
public/               品牌资产与 theme-init.js
```

## 命令

```bash
pnpm install
pnpm dev                 # Web SPA dev（:5173；/api、/admin/api、/studio/api、/preview 代理到 :3210）
pnpm build               # typecheck + 静态产物（dist/）
pnpm typecheck           # tsc --noEmit
pnpm lint                # biome check

pnpm build:desktop-renderer   # 桌面渲染器（vite，输出 desktop/renderer-dist）
pnpm build:desktop            # renderer + main tsc + esbuild 打包（desktop/package-app）
pnpm dev:desktop              # 构建并启动 Electron
pnpm package:desktop          # electron-builder 打包（mac arm64，未签名）
```

## 运行前提（联调）

- nexharness API（默认 `:3210`）已启动；auth-center（`http://localhost:3101`）已启动。
- 登录：SPA `/login` → auth-center 门户 → `?ticket=` 回跳 → `POST /api/session/exchange` 落地会话 cookie。
- 部署：静态产物 + 反向代理（`/api`、`/admin/api`、`/studio/api`、`/preview` → nexharness；子路径部署设 `NEX_BASE_PATH`）。

## 拆分来源

- 搬迁自 `XZY-Free/nexharness`（阶段③，2026-10-14）；实施记录见 nexharness 仓 `docs/split/03-client-实施记录.md`。
- `next/*` 采用 shim 别名（`src/shims/`）以保持搬迁面零改源；后续可在客户端仓库内逐步去 shim 化。
