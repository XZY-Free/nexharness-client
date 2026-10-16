/**
 * 服务端 schema 的客户端镜像（只读）。
 *
 * 定位：
 * - 本目录**不是**客户端持久层。客户端无 ORM、无迁移、无数据库连接。
 * - 这里的 drizzle 表定义（`mysqlTable` / `customType` / `index` 等）是 **stub**——
 *   用于表达「服务端表结构 + 外键目标」，让客户端能引用**列类型**与**枚举**，并保持
 *   与 auth-center / nexharness 的表结构一致。
 * - 真正的 DDL 与迁移归 **auth-center**（身份/授权表）与 **nexharness**（业务表）。
 *   本目录不参与任何迁移生成（见 `identity.ts` 文件头）。
 *
 * 为什么保留 drizzle 定义而不是换成纯 TS interface：
 * - FK 目标（如 `tenant` / `userIdentity`）需要表对象才能被引用；换成 interface 会丢失
 *   这层结构约束。
 * - `InferSelectModel` / `InferInsertModel` 导出的行类型直接来自表定义，避免手写漂移。
 *
 * 构建产物影响：无。客户端只 `import type` 本目录，drizzle 会被 tree-shake 掉
 * （已核验：dist 中不含 drizzle）。
 *
 * 命名历史：本目录原为 `lib/persistence/schema`。"persistence" 一词暗示客户端有持久层，
 * 与实际不符，故改名为 `lib/server-schema`（直述"服务端 schema 镜像"）。
 */
export {};
