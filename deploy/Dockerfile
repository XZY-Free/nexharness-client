# nexharness-client Web SPA 静态产物镜像（nginx）。
#
# 本地构建（context = 仓根）：
#   docker build -f deploy/Dockerfile -t nexharness-client:dev .
#
# 部署形态：子路径 /nexharness/（构建期注入 NEX_BASE_PATH，与运行期 apiPath 注入源一致）。
# 根路径部署：--build-arg NEX_BASE_PATH=/ 并调整 deploy/nginx.conf（见文件内注释）。
#
# 说明：桌面端由桌面分发包交付，不进本镜像；本镜像只服务 Web SPA。

# ---------- Stage 1: 依赖（electron 二进制跳过——仅桌面打包需要）----------
FROM node:24-alpine AS deps
# better-sqlite3 在受限网络下可能回退源码编译（prebuild 下载失败）——备齐 node-gyp 工具链。
RUN apk add --no-cache python3 make g++ \
  && corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- Stage 2: SPA 构建 ----------
FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 子路径部署（默认 /nexharness/）；与 nexharness basePath、ingress path 保持一致。
ARG NEX_BASE_PATH=/nexharness/
ENV NEX_BASE_PATH=${NEX_BASE_PATH}
RUN pnpm build

# ---------- Stage 3: nginx 运行时 ----------
# 基础镜像用 alpine + apk nginx（而非 docker.io/library/nginx）：
# - 依赖单一 alpine 主源，企业内网/受限镜像源环境下更稳；
# - 配置入口 /etc/nginx/http.d/default.conf（alpine nginx 默认 include）。
FROM alpine:3.19
RUN apk add --no-cache nginx \
  && mkdir -p /usr/share/nginx/html/nexharness
COPY deploy/nginx.conf /etc/nginx/http.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html/nexharness
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
