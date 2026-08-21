import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "vitehub-anti-slop-"));

afterAll(() => rmSync(fixtureDirectory, { force: true, recursive: true }));

function diagnostics(source: string): string[] {
  const fixture = join(fixtureDirectory, "fixture.ts");
  writeFileSync(fixture, source);
  const output = execFileSync(
    "pnpm",
    ["exec", "vp", "lint", "--no-ignore", "--format=json", fixture],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  // SAFETY: Oxlint's JSON formatter owns this stable diagnostic envelope.
  const result = JSON.parse(output) as { diagnostics: { code?: string }[] };
  return result.diagnostics
    .map((diagnostic) => diagnostic.code)
    .filter((code): code is string => code?.startsWith("anti-slop(") === true);
}

describe("anti-slop lexical type resolution", () => {
  test("does not fall through local type-namespace shadows", () => {
    const result = diagnostics(`
        type Result = unknown;
        type Alias = unknown;

        function safeReturn() {
          type Result = { id: string };
          return function value(): Result { return { id: "ok" }; };
        }

        namespace Scoped {
          import Alias = External.Clean;
          type Clean = Alias;
          function use(value: Alias) { return value; }
        }

        declare namespace External { type Clean = string; }
      `);
    expect(result.filter((code) => code === "anti-slop(no-unknown-type-aliases)")).toHaveLength(2);
    expect(result).not.toContain("anti-slop(no-unknown-returns)");
    expect(result).not.toContain("anti-slop(no-object-parameters)");
  });

  test("does not classify locally shadowed dictionary utilities as built-ins", () => {
    const result = diagnostics(`
        declare const data: unknown;
        function safeDictionary() {
          type Record<K, V> = readonly [K, V];
          const value: Record<string, unknown> = ["x", data];
          return value;
        }
      `);
    expect(result).not.toContain("anti-slop(no-unsafe-dictionary-type)");
  });

  test("classifies each widening evidence declaration in its own scope", () => {
    const result = diagnostics(`
        declare const input: { id: string };
        const source: Record<string, unknown> = input;
        function safeEvidence() {
          type Record<K, V> = readonly [K, V];
          const widened: unknown = source;
          // SAFETY: fixture verifies that the broad source remains broad.
          return widened as { id: string };
        }
      `);
    expect(result.filter((code) => code === "anti-slop(no-unsafe-dictionary-type)")).toHaveLength(
      1,
    );
    expect(result).not.toContain("anti-slop(no-widen-then-assert)");
  });

  test("retains diagnostics for actual global contracts", () => {
    const result = diagnostics(`
        type Result = unknown;
        function unsafeReturn(): Result { throw new Error(); }
        const unsafeDictionary: Record<string, unknown> = {};
        const precise = { id: "ok" };
        const widened: Record<string, unknown> = precise;
        // SAFETY: fixture intentionally recreates the discarded type.
        const asserted = widened as { id: string };
        void unsafeDictionary;
        void asserted;
      `);
    for (const code of [
      "anti-slop(no-unknown-type-aliases)",
      "anti-slop(no-unknown-returns)",
      "anti-slop(no-unsafe-dictionary-type)",
      "anti-slop(no-known-value-widening)",
      "anti-slop(no-widen-then-assert)",
    ]) {
      expect(result).toContain(code);
    }
  });
});
