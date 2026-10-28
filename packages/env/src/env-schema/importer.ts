import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { descriptorVariable, env } from "../core/declarations.ts";
import { invalidEnvDeclaration } from "../core/errors.ts";
import { parseEnvSchema } from "./profile.ts";

import type {
  EnvRuntimeConfigOptions,
  EnvValueSchema,
  EnvVariableDeclaration,
  EnvViteConfigOptions,
} from "../types.ts";
import type { EnvSchemaField } from "./profile.ts";

export interface EnvSchemaOptions {
  prefix?: string;
  /** Exact schema key to output path. Only Server Env supports nested paths. */
  paths?: Record<string, string>;
}

type Tree =
  | { kind: "branch"; children: Map<string, Tree> }
  | { kind: "field"; declaration: EnvVariableDeclaration };

function fail(field: EnvSchemaField | undefined, reason: string): never {
  const path = field ? `${field.source.file}:${field.source.line} (${field.key})` : "envSchema";
  throw invalidEnvDeclaration(path, `${path}: ${reason}`);
}

function outputName(name: string): string {
  const words = name.split("_").filter(Boolean);
  return words
    .map((word, index) => {
      const normalized = word === word.toUpperCase() ? word.toLowerCase() : word;
      return index === 0
        ? normalized.charAt(0).toLowerCase() + normalized.slice(1)
        : normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join("");
}

function safePath(path: string, field: EnvSchemaField, publicField: boolean): string[] {
  const segments = path.split(".");
  if (
    !segments.length ||
    (publicField && segments.length !== 1) ||
    segments.length > 16 ||
    segments.some(
      (segment) =>
        !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ||
        ["__proto__", "prototype", "constructor"].includes(segment.toLowerCase()),
    )
  ) {
    fail(field, "Output path must contain safe identifiers; Public Env paths must be flat");
  }
  if (["public", "define", "server"].includes(segments[0] || ""))
    fail(field, "Output paths cannot select an Env visibility section");
  return segments;
}

function descriptor(field: EnvSchemaField): EnvValueSchema {
  const type = field.type;
  if (type.kind === "string")
    return { ...type, minLength: Math.max(type.minLength ?? 0, field.required ? 1 : 0) };
  if (type.kind === "number") return { ...type, decimal: true };
  return type;
}

function add(
  tree: Map<string, Tree>,
  segments: string[],
  declaration: EnvVariableDeclaration,
  field: EnvSchemaField,
): void {
  const [head, ...rest] = segments;
  if (!head) return fail(field, "Output path cannot be empty");
  const existing = tree.get(head);
  if (!rest.length) {
    if (existing) fail(field, "Output path collides with another declaration");
    tree.set(head, { kind: "field", declaration });
    return;
  }
  if (existing?.kind === "field") fail(field, "Output path collides with another declaration");
  const children = existing?.children ?? new Map<string, Tree>();
  tree.set(head, { kind: "branch", children });
  add(children, rest, declaration, field);
}

function serverConfig(tree: Map<string, Tree>): EnvRuntimeConfigOptions {
  const result: EnvRuntimeConfigOptions = {};
  for (const [key, node] of tree) {
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: node.kind === "field" ? node.declaration : serverConfig(node.children),
    });
  }
  return result;
}

/** Import a committed env-spec-v1 contract. Reads schema metadata, never developer env files. */
export function envSchema(
  file: string | URL,
  options: EnvSchemaOptions = {},
): EnvViteConfigOptions {
  const filename = file instanceof URL ? fileURLToPath(file) : resolve(file);
  const prefix = options.prefix ?? "VITEHUB_";
  if (prefix && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix) || prefix.length > 128))
    fail(undefined, "Prefix must be a portable environment name prefix");
  let source: string;
  try {
    source = readFileSync(filename, "utf8");
  } catch {
    throw invalidEnvDeclaration(filename, `${filename}: Cannot read environment schema file`);
  }
  let fields: EnvSchemaField[];
  try {
    fields = parseEnvSchema(source, filename);
  } catch (error: unknown) {
    throw invalidEnvDeclaration(
      filename,
      error instanceof Error ? error.message : `${filename}: Invalid environment schema file`,
    );
  }
  const knownKeys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(options.paths ?? {})) {
    if (!knownKeys.has(key)) fail(undefined, "Path mapping refers to an undeclared schema key");
  }
  const server = new Map<string, Tree>();
  const publicConfig: Record<string, EnvVariableDeclaration> = {};
  const publicNames = new Set<string>();
  for (const field of fields) {
    const publicPrefix = `${prefix}PUBLIC_`;
    const publicField = field.key.startsWith(publicPrefix);
    if (publicField && field.sensitive)
      fail(
        field,
        "A Public Env declaration cannot be sensitive; mark it @public or @sensitive=false",
      );
    if (field.type.kind === "enum" && field.sensitive)
      fail(field, "A secret enum would expose its allowed values; use a string instead");
    const name = publicField
      ? field.key.slice(publicPrefix.length)
      : prefix && field.key.startsWith(prefix)
        ? field.key.slice(prefix.length)
        : field.key;
    const mapped: unknown =
      options.paths && Object.hasOwn(options.paths, field.key)
        ? options.paths[field.key]
        : outputName(name);
    if (typeof mapped !== "string") fail(field, "Output path must be a string");
    const segments = safePath(mapped, field, publicField);
    const declaration = descriptorVariable(descriptor(field), {
      ...(field.default !== undefined ? { default: field.default } : {}),
      mode: publicField ? "build" : "runtime",
      required: field.required,
      secret: field.sensitive,
      source: env.source(field.key, {
        canonical: false,
        skipEmpty: !field.required && field.type.kind !== "string",
      }),
    });
    if (publicField) {
      if (publicNames.has(mapped)) fail(field, "Output path collides with another declaration");
      publicNames.add(mapped);
      Object.defineProperty(publicConfig, mapped, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: declaration,
      });
    } else {
      add(server, segments, declaration, field);
    }
  }
  return { public: publicConfig, server: serverConfig(server) };
}
