import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { descriptorVariable, env } from "../src/core/declarations.ts";
import { createRuntimeRegistry } from "../src/core/resolve.ts";
import { envValueTypeName, parseEnvValue } from "../src/core/values.ts";
import { envSchema } from "../src/env-schema/index.ts";
import { SecretEnv } from "../src/secret.ts";
import { describeServerEnv, resolveServerEnv } from "../src/server.ts";

import type { EnvSchemaOptions } from "../src/env-schema/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function contract(source: string, options?: EnvSchemaOptions) {
  const directory = mkdtempSync(fileURLToPath(new URL("./fixtures/.env-schema-", import.meta.url)));
  directories.push(directory);
  const filename = join(directory, "contract.env");
  writeFileSync(filename, source);
  return envSchema(filename, options);
}

function capture(operation: () => unknown): Error {
  try {
    operation();
  } catch (error: unknown) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected an error");
}

describe("experimental envSchema()", () => {
  it("imports the actual shared profile fixtures without reading runtime secrets", () => {
    const config = envSchema(
      new URL("./fixtures/env-schema-profile/contract.env", import.meta.url),
    );
    expect(config.public).toEqual({});
    const registry = createRuntimeRegistry(config.server);
    expect(describeServerEnv(registry).entries).toContainEqual(
      expect.objectContaining({
        path: "env.server.databaseUrl",
        secret: true,
        required: true,
        hasDefault: false,
        type: "string",
      }),
    );
    expect(config.server?.port).toMatchObject({ mode: "runtime", secret: false, default: 3000 });
  });

  it("uses only prefixed PUBLIC_ names for browser exposure", () => {
    const config = contract(
      "# @public\nVITEHUB_PUBLIC_SITE_NAME=Acme\n# @public\nVITEHUB_PRIVATE_LABEL=server\n# @public\nPUBLIC_LEGACY_NAME=private\nTOKEN=",
    );
    expect(Object.keys(config.public ?? {})).toEqual(["siteName"]);
    expect(config.public?.siteName).toMatchObject({
      default: "Acme",
      mode: "build",
      secret: false,
      source: { name: "VITEHUB_PUBLIC_SITE_NAME", canonical: false },
    });
    expect(Object.keys(config.server ?? {})).toEqual(["privateLabel", "publicLegacyName", "token"]);
    expect(config.server?.privateLabel).toMatchObject({ mode: "runtime", secret: false });
  });

  it("supports an explicit custom prefix and an explicitly empty prefix", () => {
    expect(
      contract("# @public\nAPP_PUBLIC_NAME=Acme\nAPP_SECRET=", { prefix: "APP_" }).public?.name,
    ).toMatchObject({ mode: "build", default: "Acme" });
    expect(contract("# @public\nPUBLIC_NAME=Acme", { prefix: "" }).public?.name).toMatchObject({
      mode: "build",
      default: "Acme",
    });
    expect(() => contract("TOKEN=", { prefix: "BAD-PREFIX" })).toThrow(
      expect.objectContaining({ code: "ENV_DECLARATION_INVALID" }),
    );
  });

  it("reads exact schema names even when a canonical alias is set", () => {
    const config = contract("# @public\nRAW_TOKEN=\n# @public\nVITEHUB_CUSTOM_TOKEN=", {
      paths: { VITEHUB_CUSTOM_TOKEN: "token" },
    });
    const registry = createRuntimeRegistry(config.server);
    expect(
      resolveServerEnv(registry, {
        env: {
          RAW_TOKEN: "exact-raw",
          VITEHUB_RAW_TOKEN: "wrong-raw",
          VITEHUB_CUSTOM_TOKEN: "exact-custom",
          VITEHUB_TOKEN: "wrong-canonical",
        },
      }),
    ).toMatchObject({ rawToken: "exact-raw", token: "exact-custom" });
    expect(describeServerEnv(registry).entries.every((entry) => !entry.canonicalName)).toBe(true);
  });

  it("resolves typed defaults, optional empties, URL strings and secret wrappers", () => {
    const config = contract(`# @type=number(min=1, max=5, isInt=true) @public
VITEHUB_RETRIES=3
# @type=boolean @public
VITEHUB_ENABLED=false
# @type=number @optional @public
VITEHUB_LIMIT=7
# @type=number @optional @public
VITEHUB_UNSET=
# @type=url @public
VITEHUB_ENDPOINT=https://example.test
# @optional @public
VITEHUB_LABEL=""
# @type=number
VITEHUB_PIN=
# @type=enum(draft, send) @public
VITEHUB_MODE=draft`);
    const registry = createRuntimeRegistry(config.server);
    const result = resolveServerEnv(registry, {
      env: { VITEHUB_PIN: "1234", VITEHUB_LIMIT: "", VITEHUB_UNSET: "", VITEHUB_ENABLED: "1" },
    });
    expect(result).toMatchObject({
      retries: 3,
      enabled: true,
      limit: 7,
      unset: undefined,
      endpoint: "https://example.test",
      label: "",
      mode: "draft",
    });
    expect(result.pin).toBeInstanceOf(SecretEnv);
    if (result.pin instanceof SecretEnv) {
      expect(result.pin.unseal()).toBe(1234);
      expect(String(result.pin)).toBe("<redacted>");
      expect(JSON.stringify(result.pin)).not.toContain("1234");
    }
    expect(describeServerEnv(registry).entries).toContainEqual(
      expect.objectContaining({ path: "env.server.mode", type: '"draft" | "send"' }),
    );
    expect(describeServerEnv(registry).entries).toContainEqual(
      expect.objectContaining({ path: "env.server.endpoint", type: "string" }),
    );
  });

  it.each([
    ["# @type=number @public\nVITEHUB_VALUE=3", ""],
    ["# @type=number @public\nVITEHUB_VALUE=3", "0xff"],
    ["# @type=number(min=2, max=5, isInt=true) @public\nVITEHUB_VALUE=3", "1"],
    ["# @type=number(min=2, max=5, isInt=true) @public\nVITEHUB_VALUE=3", "2.5"],
    ["# @type=number(min=2, max=5, isInt=true) @public\nVITEHUB_VALUE=3", "6"],
    ["# @type=boolean @public\nVITEHUB_VALUE=true", ""],
    ["# @type=url @public\nVITEHUB_VALUE=https://example.test", "relative/path"],
    ["# @type=string(minLength=2, maxLength=5) @public\nVITEHUB_VALUE=abc", "x"],
    ["# @type=string(minLength=2, maxLength=5) @public\nVITEHUB_VALUE=abc", "abcdef"],
    ["# @public\nVITEHUB_VALUE=valid", ""],
  ])("rejects invalid present overrides without falling back to the default", (source, value) => {
    const registry = createRuntimeRegistry(contract(source).server);
    expect(() => resolveServerEnv(registry, { env: { VITEHUB_VALUE: value } })).toThrow(
      expect.objectContaining({ code: "ENV_RUNTIME_VALUE_INVALID" }),
    );
  });

  it("does not turn examples into defaults or expose rejected secret values", () => {
    const config = contract('# @example="documentation-only"\nVITEHUB_TOKEN=');
    const registry = createRuntimeRegistry(config.server);
    expect(() => resolveServerEnv(registry, { env: {} })).toThrow(
      expect.objectContaining({ code: "ENV_REQUIRED_MISSING" }),
    );
    const secretNumber = createRuntimeRegistry(contract("# @type=number\nVITEHUB_TOKEN=").server);
    const error = capture(() =>
      resolveServerEnv(secretNumber, { env: { VITEHUB_TOKEN: "private-rejected-value" } }),
    );
    expect(JSON.stringify(error)).not.toContain("private-rejected-value");
    expect(String(error.cause)).not.toContain("private-rejected-value");
  });

  it("rejects sensitive public declarations and sensitive enums without listing choices", () => {
    for (const source of [
      "VITEHUB_PUBLIC_TOKEN=",
      "# @type=enum(secret-choice-a, secret-choice-b)\nVITEHUB_TOKEN=",
    ]) {
      const error = capture(() => contract(source));
      expect(error).toMatchObject({ code: "ENV_DECLARATION_INVALID" });
      expect(String(error.cause)).not.toContain("secret-choice-a");
    }
  });

  it("allows explicit server nesting without guessing groups", () => {
    const config = contract(
      "# @public\nVITEHUB_DATABASE_URL=https://example.test\n# @public\nVITEHUB_APP_LABEL=Acme",
      { paths: { VITEHUB_DATABASE_URL: "database.url" } },
    );
    expect(resolveServerEnv(createRuntimeRegistry(config.server), { env: {} })).toEqual({
      database: { url: "https://example.test" },
      appLabel: "Acme",
    });
  });

  it.each<Record<string, string>>([
    { VITEHUB_FIRST: "__proto__.value" },
    { VITEHUB_FIRST: "nested.constructor" },
    { VITEHUB_FIRST: "public.value" },
    { VITEHUB_FIRST: "bad-path" },
    { VITEHUB_FIRST: "a", VITEHUB_SECOND: "a.child" },
    { VITEHUB_FIRST: "a.child", VITEHUB_SECOND: "a" },
    { UNKNOWN: "value" },
  ])("rejects unsafe, cross-section or colliding paths", (paths) => {
    expect(() => contract("VITEHUB_FIRST=\nVITEHUB_SECOND=", { paths })).toThrow(
      expect.objectContaining({ code: "ENV_DECLARATION_INVALID" }),
    );
  });

  it("rejects inferred name collisions and nested Public Env mappings", () => {
    expect(() => contract("VITEHUB_API_KEY=\nAPI_KEY=")).toThrow(
      expect.objectContaining({ code: "ENV_DECLARATION_INVALID" }),
    );
    expect(() =>
      contract("# @public\nVITEHUB_PUBLIC_NAME=Acme", {
        paths: { VITEHUB_PUBLIC_NAME: "nested.name" },
      }),
    ).toThrow(expect.objectContaining({ code: "ENV_DECLARATION_INVALID" }));
  });
});

describe("serializable Env descriptors", () => {
  it("preserves legacy env.number behavior while profile decimal constraints reject hex", () => {
    const registry = createRuntimeRegistry({
      legacy: env.number(),
      decimal: descriptorVariable({ kind: "number", decimal: true }, {}),
    });
    expect(
      resolveServerEnv(registry, { env: { VITEHUB_LEGACY: "0xff", VITEHUB_DECIMAL: "1e2" } }),
    ).toEqual({ legacy: 255, decimal: 100 });
    expect(() =>
      resolveServerEnv(registry, { env: { VITEHUB_LEGACY: "0xff", VITEHUB_DECIMAL: "0xff" } }),
    ).toThrow(expect.objectContaining({ code: "ENV_RUNTIME_VALUE_INVALID" }));
  });

  it("accepts typed Cloudflare bindings and retains constraints after serialization", () => {
    expect(
      parseEnvValue({ kind: "number", min: 1, max: 5, isInt: true, decimal: true }, 3),
    ).toEqual({ data: 3, success: true });
    expect(parseEnvValue({ kind: "boolean" }, false)).toEqual({ data: false, success: true });
    const registry = createRuntimeRegistry({
      limit: descriptorVariable({ kind: "number", min: 1, max: 5, isInt: true, decimal: true }, {}),
    });
    const serialized: unknown = JSON.parse(JSON.stringify(registry));
    expect(serialized).toMatchObject({
      limit: { schema: { kind: "number", min: 1, max: 5, isInt: true, decimal: true } },
    });
    expect(resolveServerEnv(registry, { env: { VITEHUB_LIMIT: 3 } }).limit).toBe(3);
  });

  it("generates string types for URL descriptors and validates defaults", () => {
    expect(envValueTypeName({ kind: "url" })).toBe("string");
    expect(() =>
      createRuntimeRegistry({
        endpoint: descriptorVariable({ kind: "url" }, { default: "relative" }),
      }),
    ).toThrow();
    expect(() =>
      createRuntimeRegistry({
        name: descriptorVariable({ kind: "string", minLength: 2 }, { default: "x" }),
      }),
    ).toThrow();
    expect(parseEnvValue({ kind: "url" }, "https://example.test")).toEqual({
      data: "https://example.test",
      success: true,
    });
  });
});
