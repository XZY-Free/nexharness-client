/**
 * UserAction 字段解析与校验（纯逻辑，无 React 依赖）。
 *
 * 从 components/thread/items/user-action-item.tsx 抽出——该组件原含 11 个顶层函数共
 * 1196 行，职责过载。本模块承担「input_schema → 表单字段」的解析与客户端校验，
 * 是安全相关的边界（fail-closed）。
 *
 * 安全口径：
 * - `input_schema` 缺失 / 空 / 含不支持类型 / 含非法正则 → 整体 fail-closed
 *   （`ok: false`），UI 不渲染表单。
 * - 客户端按已支持的 schema 子集校验，提交值经归一（number 真转数字，boolean 真转布尔），
 *   不接受"把任意文本归一成 false"这类宽松处理。
 * - 可选字段留空 → omit（提交对象省略该键）；必填留空 → 非法。
 */
import type { UserActionResolution } from "@/lib/server-schema/user-action-request";

/** user_action ThreadItem content 投影（按 request_type 收集所有可能字段）。 */
export interface UserActionContent {
  request_type?: string;
  purpose?: string;
  reason?: string;
  impact?: string;
  /** 请求状态：pending | resolved | expired（由 user_action.resolved / 平台过期任务写入）。 */
  state?: string;
  /** 过期时间（ISO 8601 字符串）。 */
  expires_at?: string;
  /** auth/grant 类型：授权范围。 */
  scope?: string | readonly string[];
  /** auth 类型：可信授权 URL（OAuth/OIDC 入口）。 */
  auth_url?: string;
  /** grant 类型：目标工具名。 */
  target_tool?: string;
  /** input 类型：JSON Schema（描述用户应提交的响应结构）。 */
  input_schema?: Record<string, unknown>;
  /** UserActionRequest（Authority）id；:resolve 必须使用此 id，禁止 fallback 到 item.id。 */
  request_id?: string;
  /** 请求方提供的标题（覆盖默认类型标题）。 */
  title?: string;
  /** 请求方提供的摘要（覆盖 reason 显示）。 */
  summary?: string;
  /** 面向用户的问题；purpose 是内部分类，不作为展示正文。 */
  prompt?: string;
  /** Agent input-required 的安全目录名称。 */
  agent_display_name?: string | null;
  /** Agent 冻结合同是否支持取消；缺失时 fail-closed。 */
  cancel_supported?: boolean;
  /** 外部 Agent confirmation 经过服务端协议校验后的安全预览。 */
  preview?: Record<string, unknown>;
  resolution?: UserActionResolution;
  /** confirmation 类型：等待确认的目标文件。 */
  target_path?: string;
  /** confirmation 类型：diff 新增/删除行数。 */
  line_additions?: number;
  /** confirmation 类型：diff 删除行数。 */
  line_deletions?: number;
  /** confirmation 类型：等待用户审阅的文本 diff。 */
  diff?: string;
}

/** 从 input_schema 提取的字段定义。 */
export interface InputFieldDef {
  key: string;
  label: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  description?: string;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** 字段无 title 时的中文默认 label：不暴露裸技术键。 */
export function defaultFieldLabel(key: string, index: number): string {
  if (key === "text") return "补充信息";
  return `输入项 ${index + 1}`;
}

/** input_schema 解析结果：ok=false 表示 schema 缺失/空/不支持/含非法 pattern，fail-closed。 */
export interface InputSchemaParseResult {
  readonly ok: boolean;
  readonly fields: readonly InputFieldDef[];
}

/**
 * 从 `input_schema` 提取表单字段（**fail-closed**）。
 *
 * 任一字段非法（类型不支持 / 正则编译失败）→ 整体返回 `ok: false`，
 * 不做"跳过坏字段继续"的宽松处理（与 UI/服务端口径一致）。
 */
export function extractInputFields(
  schema: Record<string, unknown> | undefined,
): InputSchemaParseResult {
  const fail: InputSchemaParseResult = { ok: false, fields: [] };
  if (!schema || typeof schema !== "object") return fail;
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties || typeof properties !== "object") return fail;
  const entries = Object.entries(properties);
  if (entries.length === 0) return fail;
  // required 必须是字符串**数组**：字符串（如 "a"）也能 .includes()，
  // 若不校验类型会把单字符 key 误判为必填（"a".includes("a") === true）。
  const rawRequired = schema.required;
  const requiredList: readonly string[] = Array.isArray(rawRequired)
    ? rawRequired.filter((x): x is string => typeof x === "string")
    : [];
  const fields: InputFieldDef[] = [];
  let index = 0;
  for (const [key, def] of entries) {
    if (!def || typeof def !== "object") return fail;
    const type = (def.type as string | undefined) ?? "string";
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean")
      return fail;
    const pattern = typeof def.pattern === "string" ? def.pattern : undefined;
    if (pattern) {
      try {
        void new RegExp(pattern);
      } catch {
        // 非法正则：schema 本身不可用，UI 与服务端一致 fail-closed。
        return fail;
      }
    }
    const fieldIndex = index;
    index += 1;
    fields.push({
      key,
      label:
        (def.title as string | undefined) ??
        (def.description as string | undefined) ??
        defaultFieldLabel(key, fieldIndex),
      type,
      required: requiredList.includes(key),
      description: def.description as string | undefined,
      enum: Array.isArray(def.enum) ? (def.enum as readonly string[]) : undefined,
      minLength: typeof def.minLength === "number" ? def.minLength : undefined,
      maxLength: typeof def.maxLength === "number" ? def.maxLength : undefined,
      pattern,
    });
  }
  return { ok: true, fields };
}

/** 单字段校验结果。 */
export type NormalizedFieldValue =
  | { ok: true; omit: true }
  | { ok: true; omit: false; value: string | number | boolean }
  | { ok: false };

/**
 * 客户端按已支持 schema 子集校验单字段，返回归一后的提交值。
 *
 * omitted/required 语义：可选字段留空 → omit（提交对象省略该键）；
 * 必填字段留空非法；boolean 必须显式选择 true/false（提交实际布尔值，
 * 不接受把任意杂串归一成 false）。
 */
export function normalizeFieldValue(field: InputFieldDef, raw: string): NormalizedFieldValue {
  const trimmed = raw.trim();
  if (field.type === "number" || field.type === "integer") {
    if (!trimmed) return field.required ? { ok: false } : { ok: true, omit: true };
    const num = Number(trimmed);
    if (!Number.isFinite(num) || (field.type === "integer" && !Number.isInteger(num)))
      return { ok: false };
    return { ok: true, omit: false, value: num };
  }
  if (field.type === "boolean") {
    // 未选择（空）→ 可选则省略，必填则非法；任意其他文本不接受（防把杂串归一成 false）。
    if (!trimmed) return field.required ? { ok: false } : { ok: true, omit: true };
    if (trimmed === "true") return { ok: true, omit: false, value: true };
    if (trimmed === "false") return { ok: true, omit: false, value: false };
    return { ok: false };
  }
  if (!trimmed) return field.required ? { ok: false } : { ok: true, omit: true };
  if (field.enum && !field.enum.includes(trimmed)) return { ok: false };
  if (field.minLength !== undefined && trimmed.length < field.minLength) return { ok: false };
  if (field.maxLength !== undefined && trimmed.length > field.maxLength) return { ok: false };
  if (field.pattern && !new RegExp(field.pattern).test(trimmed)) return { ok: false };
  return { ok: true, omit: false, value: trimmed };
}

/** 历史数据也按受限结构显示，永不把未知对象当 HTML、链接或可执行内容处理。 */
export function isStructuredPreview(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.keys(value).length <= 8
  );
}

/** 预览文本截断（长文本不撑破卡片）。 */
export function previewText(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}
