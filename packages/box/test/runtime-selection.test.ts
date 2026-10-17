import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { resolveBox, type BoxDefinition, type BoxRuntime } from "../src/index.ts";

describe("Box runtime selection", () => {
  it("accepts default built-ins by literal name", async () => {
    const trusted = await resolveBox({ runtime: "trusted-host" }, {});
    const crabbox = await resolveBox({ cwd: process.cwd(), runtime: "crabbox" }, {});
    const vercel = await resolveBox({ runtime: "vercel" }, {});

    expect(trusted.plan.runtime).toBe("trusted-host");
    expect(crabbox.plan.runtime).toBe("crabbox");
    expect(vercel.plan.runtime).toBe("vercel");
  });

  it("accepts configured built-ins by tagged value", async () => {
    const box = await resolveBox({
      runtime: { kind: "trusted-host", stateRoot: process.cwd() },
    }, {});

    expect(box.plan.runtime).toBe("trusted-host");
  });

  it("rejects unknown built-ins and reserved custom runtime names", async () => {
    await expect(resolveBox({
      runtime: "unknown" as never,
    }, {})).rejects.toThrow('Unknown Box runtime "unknown"');

    const custom = {
      name: "trusted-host",
      async open() {
        throw new Error("not reached");
      },
      async prepare() {
        throw new Error("not reached");
      },
    } satisfies BoxRuntime;
    await expect(resolveBox({ runtime: custom }, {})).rejects.toThrow(
      'Custom Box runtimes cannot use the reserved name "trusted-host"',
    );
  });

  it("does not accept inherited runtime capabilities or markers", async () => {
    const inherited = Object.create({
      name: "custom",
      open: async () => undefined,
      prepare: async () => undefined,
    });
    await expect(resolveBox({ runtime: inherited }, {})).rejects.toThrow(/Unknown Box runtime kind/);

    for (const constructor of [function Fake() {}, class Fake {}, { [Symbol.toStringTag]: "Function" }]) {
      const forged = Object.create({
        constructor,
        name: "custom",
        open: async () => undefined,
        prepare: async () => undefined,
      });
      await expect(resolveBox({ runtime: forged }, {})).rejects.toThrow(/Unknown Box runtime kind/);
    }

    const markerInherited = Object.create({ [Symbol.for("vitehub.box.internal-runtime")]: true });
    Object.assign(markerInherited, {
      name: "trusted-host",
      open: async () => undefined,
      prepare: async () => undefined,
    });
    await expect(resolveBox({ runtime: markerInherited }, {})).rejects.toThrow(
      'Custom Box runtimes cannot use the reserved name "trusted-host"',
    );

    const foreignRealm = runInNewContext(`Object.assign(Object.prototype, {
      name: "foreign",
      open: async () => undefined,
      prepare: async () => undefined,
    }); ({})`);
    await expect(resolveBox({ runtime: foreignRealm }, {})).rejects.toThrow(/Unknown Box runtime kind/);
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
      await expect(resolveBox({ runtime }, {})).rejects.toThrow("custom prepare reached");
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
      await expect(resolveBox({ runtime }, {})).rejects.toThrow("custom prepare reached");
    }
  });

  it("keeps built-in names closed while allowing custom runtimes", () => {
    const custom = {} as BoxRuntime;
    const definitions = [
      { runtime: "crabbox" },
      { runtime: "trusted-host" },
      { runtime: "vercel" },
      { runtime: { kind: "crabbox", profile: "worker" } },
      { runtime: { kind: "trusted-host", stateRoot: "/var/lib/vitehub" } },
      { runtime: { kind: "cloudflare", namespace: {} as never } },
      { runtime: { kind: "vercel" } },
      { runtime: custom },
    ] satisfies BoxDefinition[];
    void definitions;

    // @ts-expect-error Unknown built-in names are not accepted as Box runtimes.
    const unknown: BoxDefinition = { runtime: "unknown" };
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
