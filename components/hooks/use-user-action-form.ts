"use client";

import {
  type InputFieldDef,
  type UserActionContent,
  extractInputFields,
  normalizeFieldValue,
} from "@/lib/thread/user-action-fields";
import { useMemo, useState } from "react";

/**
 * UserAction 输入表单状态与提交逻辑（从 user-action-item.tsx 抽出）。
 *
 * 职责：
 * - 解析 `input_schema` → 字段列表（fail-closed）
 * - 维护表单值、note
 * - 客户端按 schema 子集校验（仅体验层：禁用提交、避免消费后无法重试；
 *   服务端 Ajv 校验仍是 Authority）
 * - 把表单值归一为提交对象（可选留空 → 省略该键）
 *
 * 抽出的收益：表单规则可单测（`normalizeFieldValue` 已有 25 例），
 * 主组件不再持有 160 行表单逻辑。
 */
export interface UserActionForm {
  /** schema 解析结果（ok=false 表示不可用，fail-closed）。 */
  readonly schemaOk: boolean;
  readonly fields: readonly InputFieldDef[];
  /** 单一枚举字段（用于"单击即提交"的快捷交互）；不满足时为 null。 */
  readonly singleChoiceField: InputFieldDef | null;
  readonly values: Readonly<Record<string, string>>;
  readonly userNote: string;
  /** 表单是否通过客户端校验。 */
  readonly valid: boolean;
  setValue: (key: string, value: string) => void;
  setUserNote: (note: string) => void;
  /** 归一表单值为提交对象；校验失败返回 null。 */
  buildPayload: (values?: Readonly<Record<string, string>>) => Record<string, unknown> | null;
}

export function useUserActionForm(content: UserActionContent): UserActionForm {
  const schema = useMemo(() => extractInputFields(content.input_schema), [content.input_schema]);
  const fields = schema.fields;

  const singleChoiceField =
    fields.length === 1 && fields[0]?.enum && fields[0].enum.length > 0
      ? (fields[0] ?? null)
      : null;

  const [values, setValues] = useState<Record<string, string>>({});
  const [userNote, setUserNote] = useState("");

  const valid = useMemo(() => {
    if (!schema.ok) return false;
    for (const field of fields) {
      if (!normalizeFieldValue(field, values[field.key] ?? "").ok) return false;
    }
    return true;
  }, [schema.ok, fields, values]);

  function setValue(key: string, value: string): void {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function buildPayload(
    override?: Readonly<Record<string, string>>,
  ): Record<string, unknown> | null {
    if (!schema.ok) return null;
    const source = override ?? values;
    const response: Record<string, unknown> = {};
    for (const field of fields) {
      const normalized = normalizeFieldValue(field, source[field.key] ?? "");
      if (!normalized.ok) return null;
      // 可选字段留空 → 省略该键（由 normalizeFieldValue 的 omit 语义决定）
      if (!normalized.omit) response[field.key] = normalized.value;
    }
    return response;
  }

  return {
    schemaOk: schema.ok,
    fields,
    singleChoiceField,
    values,
    userNote,
    valid,
    setValue,
    setUserNote,
    buildPayload,
  };
}
