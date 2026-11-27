import { isEnvSchemaValue } from "./json-value.ts";

import type { EnvValueSchema } from "../types.ts";

export type EnvValueParseResult =
  | { data: unknown; success: true }
  | { message: string; success: false };

export const stringValueSchema: EnvValueSchema = Object.freeze({ kind: "string" });

/** Parse one host, provider, or default value with a serializable Server Env value schema. */
export function parseEnvValue(schema: EnvValueSchema, input: unknown): EnvValueParseResult {
  switch (schema.kind) {
    case "array":
    case "object":
    case "json": {
      const json = readJsonInput(input);
      if (!json.success) return json;
      return isEnvSchemaValue(json.data) &&
        (schema.kind === "json" || matchesJsonType(schema, json.data))
        ? { data: typeof input === "string" ? json.data : structuredClone(json.data), success: true }
        : {
            success: false,
            message:
              schema.kind === "json"
                ? "Expected a JSON value."
                : "JSON value does not match the declared type.",
          };
    }
    case "list":
      return parseList(schema.items ?? stringValueSchema, input);
    case "string":
      return typeof input === "string" &&
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
      return typeof input === "string" && schema.values.includes(input)
        ? { data: input, success: true }
        : {
            message: `Expected one of ${schema.values.map((value) => JSON.stringify(value)).join(", ")}.`,
            success: false,
          };
  }
}

/** Return the TypeScript type that a value schema produces. */
export function envValueTypeName(schema: EnvValueSchema): string {
  switch (schema.kind) {
    case "array":
      return `Array<${schema.items ? envValueTypeName(schema.items) : "unknown"}>`;
    case "object": {
      if (!schema.properties) return "Record<string, unknown>";
      const properties = Object.entries(schema.properties);
      return properties.length
        ? `{ ${properties
            .map(([key, property]) => `${JSON.stringify(key)}: ${envValueTypeName(property)}`)
            .join("; ")} }`
        : "Record<string, never>";
    }
    case "list":
      return `Array<${envValueTypeName(schema.items ?? stringValueSchema)}>`;
    case "json":
      return "unknown";
    case "enum":
      return schema.values.map((value) => JSON.stringify(value)).join(" | ");
    case "url":
      return "string";
    default:
      return schema.kind;
  }
}

/** Item kinds that `env.list()` accepts. Each one parses a single string. */
export const listItemKinds: ReadonlySet<EnvValueSchema["kind"]> = new Set(["boolean", "enum", "number", "string", "url"]);

/** Read a string as JSON text. Other values, such as a default or a typed host binding, are already parsed. */
export function readJsonInput(input: unknown): EnvValueParseResult {
  if (typeof input !== "string") return { data: input, success: true };
  try {
    return { data: JSON.parse(input), success: true };
  } catch {
    return { success: false, message: "Expected valid JSON." };
  }
}

function parseList(item: EnvValueSchema, input: unknown): EnvValueParseResult {
  const items =
    typeof input === "string"
      ? input
          .split(/[,\n]/)
          .map((value) => value.trim())
          .filter(Boolean)
      : input;
  if (!Array.isArray(items)) return { message: "Expected a comma-separated list.", success: false };
  const data: unknown[] = [];
  for (const [index, value] of items.entries()) {
    const result = parseEnvValue(item, value);
    if (!result.success) return { message: `Item ${index + 1}: ${result.message}`, success: false };
    data.push(result.data);
  }
  return { data, success: true };
}

function parseBoolean(input: unknown): EnvValueParseResult {
  if (typeof input === "boolean") return { data: input, success: true };
  const normalized = typeof input === "string" ? input.trim().toLowerCase() : undefined;
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
    typeof input === "string" &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input.trim())
  ) {
    return { message: "Expected a finite decimal number.", success: false };
  }
  const value = typeof input === "string" && input.trim() ? Number(input) : input;
  if (typeof value !== "number" || !Number.isFinite(value))
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
  if (typeof input === "string") {
    try {
      if (new URL(input).protocol) return { data: input, success: true };
    } catch {}
  }
  return { message: "Expected an absolute URL.", success: false };
}

function matchesJsonType(schema: EnvValueSchema, value: unknown): boolean {
  switch (schema.kind) {
    case "array":
      return (
        Array.isArray(value) &&
        (!schema.items ||
          value.every((item) => schema.items && matchesJsonType(schema.items, item)))
      );
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (!schema.properties ||
          (Object.keys(value).length === Object.keys(schema.properties).length &&
            Object.entries(schema.properties).every(
              ([key, property]) =>
                Object.hasOwn(value, key) && matchesJsonType(property, Reflect.get(value, key)),
            )))
      );
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && parseEnvValue(schema, value).success;
    default:
      return typeof value === "string" && parseEnvValue(schema, value).success;
  }
}

export function schemaContainsEnum(schema: EnvValueSchema): boolean {
  switch (schema.kind) {
    case "enum":
      return true;
    case "array":
    case "list":
      return !!schema.items && schemaContainsEnum(schema.items);
    case "object":
      return Object.values(schema.properties ?? {}).some(schemaContainsEnum);
    default:
      return false;
  }
}
