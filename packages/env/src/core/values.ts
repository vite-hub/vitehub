import { hasRuntimeType } from "../internal/runtime-type.ts";

import type { EnvValueSchema } from "../types.ts";

export type EnvValueParseResult =
  | { data: unknown; success: true }
  | { message: string; success: false };

export const stringValueSchema: EnvValueSchema = Object.freeze({ kind: "string" });

/** Parse one host, provider, or default value with a serializable Server Env value schema. */
export function parseEnvValue(schema: EnvValueSchema, input: unknown): EnvValueParseResult {
  switch (schema.kind) {
    case "string":
      return hasRuntimeType(input, "string") &&
        (schema.minLength === undefined || input.length >= schema.minLength) &&
        (schema.maxLength === undefined || input.length <= schema.maxLength)
        ? { data: input, success: true }
        : {
            message:
              schema.minLength === undefined && schema.maxLength === undefined
                ? "Expected a string."
                : "Expected a string within the declared length constraints.",
            success: false,
          };
    case "boolean":
      return parseBoolean(input);
    case "number":
      return parseNumber(input, schema);
    case "url":
      return parseUrl(input);
    case "enum":
      return hasRuntimeType(input, "string") && schema.values.includes(input)
        ? { data: input, success: true }
        : {
            message: `Expected one of ${schema.values.map((value) => JSON.stringify(value)).join(", ")}.`,
            success: false,
          };
  }
}

/** Return the TypeScript type that a value schema produces. */
export function envValueTypeName(schema: EnvValueSchema): string {
  return schema.kind === "enum"
    ? schema.values.map((value) => JSON.stringify(value)).join(" | ")
    : schema.kind === "url"
      ? "string"
      : schema.kind;
}

function parseBoolean(input: unknown): EnvValueParseResult {
  if (hasRuntimeType(input, "boolean")) return { data: input, success: true };
  const normalized = hasRuntimeType(input, "string") ? input.trim().toLowerCase() : undefined;
  if (normalized === "true" || normalized === "1") return { data: true, success: true };
  if (normalized === "false" || normalized === "0") return { data: false, success: true };
  return { message: "Expected a boolean: true, false, 1, or 0.", success: false };
}

function parseNumber(
  input: unknown,
  schema: Extract<EnvValueSchema, { kind: "number" }>,
): EnvValueParseResult {
  if (
    schema.decimal &&
    hasRuntimeType(input, "string") &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input.trim())
  ) {
    return { message: "Expected a finite decimal number.", success: false };
  }
  const value = hasRuntimeType(input, "string") && input.trim() ? Number(input) : input;
  if (!hasRuntimeType(value, "number") || !Number.isFinite(value))
    return { message: "Expected a finite number.", success: false };
  if (
    (schema.isInt && !Number.isSafeInteger(value)) ||
    (schema.min !== undefined && value < schema.min) ||
    (schema.max !== undefined && value > schema.max)
  ) {
    return { message: "Expected a number within the declared constraints.", success: false };
  }
  return { data: value, success: true };
}

function parseUrl(input: unknown): EnvValueParseResult {
  if (hasRuntimeType(input, "string")) {
    try {
      if (new URL(input).protocol) return { data: input, success: true };
    } catch {}
  }
  return { message: "Expected an absolute URL.", success: false };
}
