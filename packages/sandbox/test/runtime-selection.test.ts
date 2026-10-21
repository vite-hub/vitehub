import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { resolveSandbox, type SandboxDefinition, type SandboxRuntime } from "../src/index.ts";

describe("Sandbox runtime selection", () => {
  it("accepts default built-ins by literal name", async () => {
    const trusted = await resolveSandbox({ runtime: "trusted-host" }, {});
    const crabbox = await resolveSandbox({ cwd: process.cwd(), runtime: "crabbox" }, {});
    const vercel = await resolveSandbox({ runtime: "vercel" }, {});

    expect(trusted.plan.runtime).toBe("trusted-host");
    expect(crabbox.plan.runtime).toBe("crabbox");
    expect(vercel.plan.runtime).toBe("vercel");
  });

  it("accepts configured built-ins by tagged value", async () => {
    const sandbox = await resolveSandbox({
      runtime: { kind: "trusted-host", stateRoot: process.cwd() },
    }, {});

    expect(sandbox.plan.runtime).toBe("trusted-host");
  });

  it("rejects unknown built-ins and reserved custom runtime names", async () => {
    await expect(resolveSandbox({
      runtime: "unknown" as never,
    }, {})).rejects.toThrow('Unknown Sandbox runtime "unknown"');

    const custom = {
      name: "trusted-host",
      async open() {
        throw new Error("not reached");
      },
      async prepare() {
        throw new Error("not reached");
      },
    } satisfies SandboxRuntime;
    await expect(resolveSandbox({ runtime: custom }, {})).rejects.toThrow(
      'Custom Sandbox runtimes cannot use the reserved name "trusted-host"',
    );
  });

  it("does not accept inherited runtime capabilities or markers", async () => {
    const inherited = Object.create({
      name: "custom",
      open: async () => undefined,
      prepare: async () => undefined,
    });
    await expect(resolveSandbox({ runtime: inherited }, {})).rejects.toThrow(/Unknown Sandbox runtime kind/);

    for (const constructor of [function Fake() {}, class Fake {}, { [Symbol.toStringTag]: "Function" }]) {
      const forged = Object.create({
        constructor,
        name: "custom",
        open: async () => undefined,
        prepare: async () => undefined,
      });
      await expect(resolveSandbox({ runtime: forged }, {})).rejects.toThrow(/Unknown Sandbox runtime kind/);
    }

    const markerInherited = Object.create({ [Symbol.for("vitehub.sandbox.internal-runtime")]: true });
    Object.assign(markerInherited, {
      name: "trusted-host",
      open: async () => undefined,
      prepare: async () => undefined,
    });
    await expect(resolveSandbox({ runtime: markerInherited }, {})).rejects.toThrow(
      'Custom Sandbox runtimes cannot use the reserved name "trusted-host"',
    );

    const foreignRealm = runInNewContext(`Object.assign(Object.prototype, {
      name: "foreign",
      open: async () => undefined,
      prepare: async () => undefined,
    }); ({})`);
    await expect(resolveSandbox({ runtime: foreignRealm }, {})).rejects.toThrow(/Unknown Sandbox runtime kind/);
  });

  it("accepts runtime capabilities from class prototypes across realms", async () => {
    class CustomRuntime {
      get name() { return "custom"; }
      async open(): Promise<never> { throw new Error("not reached"); }
      async prepare(): Promise<never> { throw new Error("custom prepare reached"); }
    }
    class DerivedRuntime extends CustomRuntime {}
    const foreign = runInNewContext(`new (class CustomRuntime {
      get name() { return "custom"; }
      async open() { throw new Error("not reached"); }
      async prepare() { throw new Error("custom prepare reached"); }
    })()`);
    for (const runtime of [new CustomRuntime(), new DerivedRuntime(), foreign]) {
      await expect(resolveSandbox({ runtime }, {})).rejects.toThrow("custom prepare reached");
    }
  });

  it("accepts class runtimes with tagged constructors across realms", async () => {
    class TaggedRuntime {
      static [Symbol.toStringTag] = "TaggedRuntime";
      get name() { return "custom"; }
      async open(): Promise<never> { throw new Error("not reached"); }
      async prepare(): Promise<never> { throw new Error("custom prepare reached"); }
    }
    class DerivedRuntime extends TaggedRuntime {}
    const foreign = runInNewContext(`new (class TaggedRuntime {
      static [Symbol.toStringTag] = "TaggedRuntime";
      get name() { return "custom"; }
      async open() { throw new Error("not reached"); }
      async prepare() { throw new Error("custom prepare reached"); }
    })()`);
    for (const runtime of [new TaggedRuntime(), new DerivedRuntime(), foreign]) {
      await expect(resolveSandbox({ runtime }, {})).rejects.toThrow("custom prepare reached");
    }
  });

  it("keeps built-in names closed while allowing custom runtimes", () => {
    const custom = {} as SandboxRuntime;
    const definitions = [
      { runtime: "crabbox" },
      { runtime: "trusted-host" },
      { runtime: "vercel" },
      { runtime: { kind: "crabbox", profile: "worker" } },
      { runtime: { kind: "trusted-host", stateRoot: "/var/lib/vitehub" } },
      { runtime: { kind: "cloudflare", namespace: {} as never } },
      { runtime: { kind: "vercel" } },
      { runtime: custom },
    ] satisfies SandboxDefinition[];
    void definitions;

    // @ts-expect-error Unknown built-in names are not accepted as Sandbox runtimes.
    const unknown: SandboxDefinition = { runtime: "unknown" };
    void unknown;
  });

  it("loads optional provider peers only after their built-in runtime is opened", async () => {
    const dist = new URL("../dist/", import.meta.url);
    const [index, cloudflare, vercel] = await Promise.all([
      readFile(new URL("index.js", dist), "utf8"),
      readFile(new URL("internal/cloudflare.js", dist), "utf8"),
      readFile(new URL("internal/vercel.js", dist), "utf8"),
    ]);

    expect(index).not.toContain("@cloudflare/sandbox");
    expect(index).not.toContain("@vercel/sandbox");
    expect(cloudflare).toMatch(/\bimport\(["']@cloudflare\/sandbox["']\)/);
    expect(cloudflare).not.toContain("@vercel/sandbox");
    expect(vercel).toMatch(/\bimport\(["']@vercel\/sandbox["']\)/);
    expect(vercel).not.toContain("@cloudflare/sandbox");
  });
});
