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

  test("keeps switch-local aliases inside the switch", () => {
    const result = diagnostics(`
        declare const condition: boolean;
        switch (condition) {
          case true:
            type Record<K, V> = readonly [K, V];
            const local: Record<string, unknown> = ["id", { id: "ok" }];
            void local;
            break;
        }
        const dictionary: Record<string, unknown> = { id: "ok" };
        // SAFETY: fixture intentionally recreates the discarded type.
        const asserted = dictionary as { id: string };
        void asserted;
      `);
    expect(result).toContain("anti-slop(no-unsafe-dictionary-type)");
    expect(result).toContain("anti-slop(no-known-value-widening)");
    expect(result).toContain("anti-slop(no-widen-then-assert)");
  });

  test("resolves local aliases and assertion targets at their use sites", () => {
    const result = diagnostics(`
        type Value = unknown;
        declare const data: unknown;
        function safe() {
          type Value = { id: string };
          type Record<K, V> = { key: K; value: V };
          const value: Value = { id: "ok" };
          const record = { key: "id", value: data } as Record<string, unknown>;
          return { value, record };
        }
      `);
    expect(result.filter((code) => code === "anti-slop(no-unknown-type-aliases)")).toHaveLength(1);
    expect(result).not.toContain("anti-slop(no-known-value-widening)");
  });

  test("covers equivalent module, member, and generic alias syntax", () => {
    const result = diagnostics(`
        declare const fallback: typeof vi.mock;
        const { mock = fallback } = vi;
        mock("./dependency");
        declare const payload: Record<string, unknown>;
        void payload["shape"];
        type Identity<T> = T;
        function use(value: Identity<object>) { return value; }
      `);
    expect(result).toContain("anti-slop(no-module-mocking)");
    expect(result).toContain("anti-slop(no-shape-in-symbol-names)");
    expect(result).toContain("anti-slop(no-object-parameters)");
  });

  test("resolves composed generic aliases and transparent assertion expressions", () => {
    const result = diagnostics(`
        type Identity<T> = T;
        type Wrapper<T> = Identity<T>;
        type Defaulted<T, U = T> = U;
        type SelectSecond<T, U> = U;
        type Reused<T> = SelectSecond<string, T>;
        type Payload = Identity<unknown>;
        function accept(value: Wrapper<object>) { return value; }
        function acceptDefault(value: Defaulted<object>) { return value; }
        function acceptReused(value: Reused<object>) { return value; }
        function consume(value: Identity<unknown>) { return value; }
        function load(): Identity<unknown> { throw new Error(); }
        const precise = { id: "ok" };
        const widened: unknown = precise;
        // SAFETY: fixture intentionally recreates the discarded type.
        const asserted = widened! as { id: string };
        void asserted;
      `);
    for (const code of [
      "anti-slop(no-object-parameters)",
      "anti-slop(no-unknown-parameters)",
      "anti-slop(no-unknown-returns)",
      "anti-slop(no-unknown-type-aliases)",
      "anti-slop(no-widen-then-assert)",
    ]) {
      expect(result).toContain(code);
    }
  });

  test("keeps free alias references outside caller substitutions", () => {
    const result = diagnostics(`
        type T = unknown;
        type Identity<X> = T;
        type Wrapper<T> = Identity<T>;
        function consumeUnsafe(value: Wrapper<string>) { return value; }

        type U = string;
        type SafeIdentity<X> = U;
        type SafeWrapper<U> = SafeIdentity<U>;
        function consumeSafe(value: SafeWrapper<unknown>) { return value; }
      `);
    expect(result.filter((code) => code === "anti-slop(no-unknown-parameters)")).toHaveLength(1);
  });

  test("preserves caller substitutions inside compound alias arguments", () => {
    const result = diagnostics(`
        type Identity<T> = T;
        type Container<T> = T;
        type Wrapper<T> = Identity<Container<T>>;
        type Dictionary<T> = Record<string, T>;
        type DictionaryWrapper<T> = Dictionary<Identity<Container<T>>>;
        type Hidden = Wrapper<unknown>;
        type HiddenDictionary = DictionaryWrapper<unknown>;
        function unknownInput(value: Wrapper<unknown>) { return value; }
        function objectInput(value: Wrapper<object>) { return value; }
        function unknownOutput(): Wrapper<unknown> { throw new Error(); }
      `);
    for (const code of [
      "anti-slop(no-object-parameters)",
      "anti-slop(no-unknown-parameters)",
      "anti-slop(no-unknown-returns)",
      "anti-slop(no-unknown-type-aliases)",
      "anti-slop(no-unsafe-dictionary-type)",
    ]) {
      expect(result.filter((diagnostic) => diagnostic === code)).toHaveLength(1);
    }
  });

  test("resolves namespace imports for test framework objects", () => {
    const result = diagnostics(`
        import * as vitest from "vitest";
        import * as jestGlobals from "@jest/globals";
        vitest.vi.mock("./vitest-dependency");
        jestGlobals.jest.unstable_mockModule("./jest-dependency");
        const { vi: framework } = vitest;
        const { jest: testFramework } = jestGlobals;
        framework.mock("./destructured-vitest-dependency");
        testFramework.mock("./destructured-jest-dependency");
      `);
    expect(result.filter((code) => code === "anti-slop(no-module-mocking)")).toHaveLength(4);
  });

  test("treats imported transparent built-ins as local type shadows", () => {
    const result = diagnostics(`
        import type { Promise } from "./contract";
        function load(): Promise<unknown> { throw new Error(); }
        void load;
      `);
    expect(result).not.toContain("anti-slop(no-unknown-returns)");
  });

  test("keeps static-block aliases inside the static block", () => {
    const result = diagnostics(`
        type Result = unknown;
        class Safe {
          static {
            type Result = { id: string };
            function value(): Result { return { id: "ok" }; }
            void value;
          }
        }
        void Safe;
      `);
    expect(result.filter((code) => code === "anti-slop(no-unknown-type-aliases)")).toHaveLength(1);
    expect(result).not.toContain("anti-slop(no-unknown-returns)");
  });

  test("resolves widening aliases in their declaration scopes", () => {
    const result = diagnostics(`
        type Entry = { id: string };
        type Target = Entry;
        function createSafe() {
          type Entry = unknown;
          const value: Target = { id: "ok" };
          return value;
        }

        type UnsafeEntry = unknown;
        type UnsafeTarget = UnsafeEntry;
        function createUnsafe() {
          type UnsafeEntry = { id: string };
          const value: UnsafeTarget = { id: "lost" };
          return value;
        }
        const unionWidened: unknown | string = { id: "lost" };
        void unionWidened;
      `);
    expect(result.filter((code) => code === "anti-slop(no-known-value-widening)")).toHaveLength(2);
  });

  test("resolves aliases when tracking widened bindings", () => {
    const result = diagnostics(`
        type Broad = unknown;
        const widened: Broad = { id: "lost" };
        // SAFETY: fixture intentionally recreates the discarded type.
        const restored = widened as { id: string };
        void restored;
      `);
    expect(result.filter((code) => code === "anti-slop(no-widen-then-assert)")).toHaveLength(1);
  });

  test("preserves any through widened binding aliases", () => {
    const result = diagnostics(`
        type Broad = any;
        type WrappedBroad = NonNullable<any>;
        const direct: any = { id: "direct" };
        const aliased: Broad = { id: "aliased" };
        const wrapped: WrappedBroad = { id: "wrapped" };
        // SAFETY: fixture intentionally recreates the discarded direct type.
        const directRestored = direct as { id: string };
        // SAFETY: fixture intentionally recreates the discarded aliased type.
        const aliasedRestored = aliased as { id: string };
        // SAFETY: fixture intentionally recreates the discarded wrapped type.
        const wrappedRestored = wrapped as { id: string };
        namespace Scoped {
          type NonNullable<T> = string;
          type Safe = NonNullable<any>;
          const safe: Safe = "kept";
          // SAFETY: fixture verifies that a local wrapper is not treated as the built-in.
          export const unchanged = safe as string;
        }
        void directRestored;
        void aliasedRestored;
        void wrappedRestored;
        void Scoped;
      `);
    expect(result.filter((code) => code === "anti-slop(no-widen-then-assert)")).toHaveLength(3);
  });

  test("preserves unary evidence when tracking widened bindings", () => {
    const result = diagnostics(`
        declare const flag: boolean;
        const widened: unknown = !flag;
        // SAFETY: fixture intentionally recreates the discarded type.
        const restored = widened as boolean;
        const precise = !flag;
        // SAFETY: fixture verifies that precise evidence was not widened.
        const unchanged = precise as boolean;
        void restored;
        void unchanged;
      `);
    expect(result.filter((code) => code === "anti-slop(no-known-value-widening)")).toHaveLength(1);
    expect(result.filter((code) => code === "anti-slop(no-widen-then-assert)")).toHaveLength(1);
  });

  test("preserves binary evidence when tracking widened bindings", () => {
    const result = diagnostics(`
        declare const id: string;
        const widened: unknown = "prefix-" + id;
        // SAFETY: fixture intentionally recreates the discarded type.
        const restored = widened as string;
        const precise = "prefix-" + id;
        // SAFETY: fixture verifies that precise evidence was not widened.
        const unchanged = precise as string;
        void restored;
        void unchanged;
      `);
    expect(result.filter((code) => code === "anti-slop(no-known-value-widening)")).toHaveLength(1);
    expect(result.filter((code) => code === "anti-slop(no-widen-then-assert)")).toHaveLength(1);
  });

  test("preserves recursively known conditional evidence", () => {
    const result = diagnostics(`
        declare const flag: boolean;
        declare function loadUnknown(): unknown;
        const widened: unknown = flag ? { id: "a" } : { id: "b" };
        // SAFETY: fixture intentionally recreates the discarded type.
        const restored = widened as { id: string };
        const uncertain: unknown = flag ? { id: "known" } : loadUnknown();
        // SAFETY: fixture verifies that both branches must establish evidence.
        const unresolved = uncertain as { id: string };
        void restored;
        void unresolved;
      `);
    expect(result.filter((code) => code === "anti-slop(no-known-value-widening)")).toHaveLength(2);
    expect(result.filter((code) => code === "anti-slop(no-widen-then-assert)")).toHaveLength(1);
  });

  test("checks assignments to annotated class fields", () => {
    const result = diagnostics(`
        class Store {
          value: unknown;
          set() { this.value = { id: "lost" }; }
        }

        type Value = { id: string };
        class SafeStore {
          value: Value;
          set() { this.value = { id: "kept" }; }
        }

        const other = new Store();
        other.value = { id: "not-statically-owned" };
        void SafeStore;
      `);
    expect(result.filter((code) => code === "anti-slop(no-known-value-widening)")).toHaveLength(1);
  });

  test("checks dictionary interface heritage", () => {
    const result = diagnostics(`
        interface UnsafeEnvironment extends Record<string, unknown> {}
        interface SafeEnvironment extends Record<string, string> {}
        void (null as unknown as UnsafeEnvironment);
        void (null as unknown as SafeEnvironment);
      `);
    expect(result.filter((code) => code === "anti-slop(no-unsafe-dictionary-type)")).toHaveLength(
      1,
    );
  });

  test("checks annotated default parameter initializers", () => {
    const result = diagnostics(`
        type Precise = { id: string };
        function unsafe(value: Record<string, string> = { id: "lost" }) { return value; }
        function safe(value: Precise = { id: "kept" }) { return value; }
        void unsafe;
        void safe;
      `);
    expect(result.filter((code) => code === "anti-slop(no-known-value-widening)")).toHaveLength(1);
  });

  test("unwraps TypeScript expression wrappers in conditional empty-object spreads", () => {
    const result = diagnostics(`
        declare const condition: boolean;
        const first = { ...((condition ? { id: "x" } : {}) satisfies object) };
        const second = { ...(condition ? { id: "x" } : ({} satisfies object)) };
        void first;
        void second;
      `);
    expect(
      result.filter((code) => code === "anti-slop(no-conditional-empty-object-spread)"),
    ).toHaveLength(2);
  });

  test("resolves qualified and generic aliases across contract rules", () => {
    const result = diagnostics(`
        namespace Contracts {
          export type Identity<T> = T;
          export type Dictionary<T> = Record<string, T>;
          export type UnsafeValue = object;
          export type Nested = UnsafeValue;
        }
        type Hidden = Contracts.Identity<unknown>;
        function unknownInput(value: Contracts.Identity<unknown>) { return value; }
        function objectInput(value: Contracts.Identity<object>) { return value; }
        function unknownOutput(): Contracts.Identity<unknown> { throw new Error(); }
        const dictionary: Record<string, Contracts.UnsafeValue> = {};
        const genericWidening: Contracts.Identity<object> = { id: "lost" };
        const nestedWidening: Contracts.Nested = { id: "lost" };
        interface QualifiedUnsafeEnvironment extends Contracts.Dictionary<unknown> {}
        interface QualifiedSafeEnvironment extends Contracts.Dictionary<string> {}
        namespace Outer {
          export namespace Contracts {
            export type Identity<T> = T;
          }
          type RelativeHidden = Contracts.Identity<unknown>;
          function relativeInput(value: Contracts.Identity<unknown>) { return value; }
          function relativeObjectInput(value: Contracts.Identity<object>) { return value; }
          function relativeOutput(): Contracts.Identity<unknown> { throw new Error(); }
        }
        void dictionary;
        void genericWidening;
        void nestedWidening;
        void (null as unknown as QualifiedUnsafeEnvironment);
        void (null as unknown as QualifiedSafeEnvironment);
        void Outer;
      `);
    for (const code of [
      "anti-slop(no-unknown-type-aliases)",
      "anti-slop(no-unknown-parameters)",
      "anti-slop(no-object-parameters)",
      "anti-slop(no-unknown-returns)",
      "anti-slop(no-unsafe-dictionary-type)",
    ]) {
      expect(result).toContain(code);
    }
    expect(result.filter((code) => code === "anti-slop(no-known-value-widening)")).toHaveLength(2);
  });

  test("resolves qualified aliases relative to their enclosing namespace", () => {
    const result = diagnostics(`
        namespace Outer {
          export namespace Contracts {
            export type Identity<T> = T;
            export type Container<T> = T;
            export type Dictionary<T> = Record<string, Identity<Container<T>>>;
          }
          type Hidden = Contracts.Identity<unknown>;
          function unknownInput(value: Contracts.Identity<unknown>) { return value; }
          function objectInput(value: Contracts.Identity<object>) { return value; }
          function unknownOutput(): Contracts.Identity<unknown> { throw new Error(); }
          interface UnsafeEnvironment extends Contracts.Dictionary<unknown> {}
          interface SafeEnvironment extends Contracts.Dictionary<string> {}
        }
        void Outer;
      `);
    for (const code of [
      "anti-slop(no-object-parameters)",
      "anti-slop(no-unknown-parameters)",
      "anti-slop(no-unknown-returns)",
      "anti-slop(no-unknown-type-aliases)",
      "anti-slop(no-unsafe-dictionary-type)",
    ]) {
      expect(result.filter((diagnostic) => diagnostic === code)).toHaveLength(1);
    }
  });

  test("resolves every segment of dotted namespace declarations", () => {
    const result = diagnostics(`
        namespace A.B {
          export type Identity<T> = T;
          export type Dictionary<T> = Record<string, T>;
        }
        type Hidden = A.B.Identity<unknown>;
        type UnresolvedBare = B.Identity<unknown>;
        function unknownInput(value: A.B.Identity<unknown>) { return value; }
        function objectInput(value: A.B.Identity<object>) { return value; }
        function unknownOutput(): A.B.Identity<unknown> { throw new Error(); }
        interface UnsafeEnvironment extends A.B.Dictionary<unknown> {}
        interface SafeEnvironment extends A.B.Dictionary<string> {}
        void (null as unknown as UnresolvedBare);
        void (null as unknown as UnsafeEnvironment);
        void (null as unknown as SafeEnvironment);
      `);
    for (const code of [
      "anti-slop(no-object-parameters)",
      "anti-slop(no-unknown-parameters)",
      "anti-slop(no-unknown-returns)",
      "anti-slop(no-unknown-type-aliases)",
      "anti-slop(no-unsafe-dictionary-type)",
    ]) {
      expect(result.filter((diagnostic) => diagnostic === code)).toHaveLength(1);
    }
  });

  test("resolves exports across merged namespace blocks", () => {
    const result = diagnostics(`
        namespace Contracts {
          export type Identity<T> = T;
          export type Dictionary<T> = Record<string, T>;
          type PrivateIdentity<T> = T;
        }
        namespace Contracts {
          type Hidden = Identity<unknown>;
          type UnresolvedPrivate = PrivateIdentity<unknown>;
          function unknownInput(value: Identity<unknown>) { return value; }
          function objectInput(value: Identity<object>) { return value; }
          function unknownOutput(): Identity<unknown> { throw new Error(); }
          interface UnsafeEnvironment extends Dictionary<unknown> {}
          interface SafeEnvironment extends Dictionary<string> {}
          void (null as unknown as UnresolvedPrivate);
          void (null as unknown as UnsafeEnvironment);
          void (null as unknown as SafeEnvironment);
        }
        void Contracts;
      `);
    for (const code of [
      "anti-slop(no-object-parameters)",
      "anti-slop(no-unknown-parameters)",
      "anti-slop(no-unknown-returns)",
      "anti-slop(no-unknown-type-aliases)",
      "anti-slop(no-unsafe-dictionary-type)",
    ]) {
      expect(result.filter((diagnostic) => diagnostic === code)).toHaveLength(1);
    }
  });

  test("classifies merged interfaces by all declarations", () => {
    const result = diagnostics(`
        interface EmptyValue {}
        interface EmptyValue {}
        interface PopulatedValue {}
        interface PopulatedValue { id: string }
        interface BaseValue { id: string }
        interface InheritedValue {}
        interface InheritedValue extends BaseValue {}
        type Unsafe = Record<string, EmptyValue>;
        type SafePopulated = Record<string, PopulatedValue>;
        type SafeInherited = Record<string, InheritedValue>;
        void (null as unknown as Unsafe);
        void (null as unknown as SafePopulated);
        void (null as unknown as SafeInherited);
      `);
    expect(result.filter((code) => code === "anti-slop(no-unsafe-dictionary-type)")).toHaveLength(
      1,
    );
  });

  test("recognizes unshadowed host-global Reflect objects", () => {
    const result = diagnostics(`
        declare const target: object;
        declare const key: PropertyKey;
        declare const fn: (...values: unknown[]) => unknown;
        declare const receiver: unknown;
        declare const args: unknown[];
        window.Reflect.get(target, key);
        self.Reflect.apply(fn, receiver, args);
        (globalThis!).Reflect.get(target, key);
        (globalThis satisfies typeof globalThis).Reflect.get(target, key);
        // SAFETY: fixture verifies transparent assertions around a host global.
        (globalThis as typeof globalThis).Reflect.get(target, key);
        // SAFETY: fixture verifies angle-bracket assertions around a host global.
        (<typeof globalThis>self).Reflect.apply(fn, receiver, args);
        // SAFETY: fixture verifies assertions around a worker host global.
        (self as typeof globalThis).Reflect.apply(fn, receiver, args);
        function safe(window: { Reflect: { get(value: object, property: PropertyKey): unknown } }) {
          // SAFETY: fixture verifies transparent wrappers retain the lexical shadow.
          return (window as typeof globalThis).Reflect.get(target, key);
        }
        function safeWorker(self: { Reflect: { apply: typeof Reflect.apply } }) {
          return (self!).Reflect.apply(fn, receiver, args);
        }
        void safe;
        void safeWorker;
      `);
    expect(result.filter((code) => code === "anti-slop(no-reflect-get)")).toHaveLength(4);
    expect(result.filter((code) => code === "anti-slop(no-reflect-apply)")).toHaveLength(3);
  });

  test("tracks qualified dictionary alias cycles by declaration", () => {
    const result = diagnostics(`
        namespace B {
          export type Dictionary<T> = Record<string, T>;
        }
        namespace A {
          export type Dictionary<T> = B.Dictionary<T>;
        }
        type Unsafe = A.Dictionary<unknown>;
        type Safe = A.Dictionary<string>;
        void (null as unknown as Unsafe);
        void (null as unknown as Safe);
      `);
    expect(result.filter((code) => code === "anti-slop(no-unsafe-dictionary-type)")).toHaveLength(
      1,
    );
  });

  test("resolves import-equals roots in qualified type names", () => {
    const result = diagnostics(`
        namespace Contracts {
          export type Identity<T> = T;
          export type Dictionary<T> = Record<string, T>;
        }
        namespace Scoped {
          import C = Contracts;
          type Hidden = C.Identity<unknown>;
          function unknownInput(value: C.Identity<unknown>) { return value; }
          function objectInput(value: C.Identity<object>) { return value; }
          function unknownOutput(): C.Identity<unknown> { throw new Error(); }
          interface UnsafeEnvironment extends C.Dictionary<unknown> {}
          interface SafeEnvironment extends C.Dictionary<string> {}
        }
        void Scoped;
      `);
    for (const code of [
      "anti-slop(no-object-parameters)",
      "anti-slop(no-unknown-parameters)",
      "anti-slop(no-unknown-returns)",
      "anti-slop(no-unknown-type-aliases)",
      "anti-slop(no-unsafe-dictionary-type)",
    ]) {
      expect(result.filter((diagnostic) => diagnostic === code)).toHaveLength(1);
    }
  });
});
