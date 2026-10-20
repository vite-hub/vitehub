import { describe, expect, it } from "vitest";

import { resolveSandbox } from "../src/index.ts";

describe("Sandbox definition boundaries", () => {
  it.each(["from", "contents"] as const)(
    "rejects file declarations with inherited %s",
    async (key) => {
      const inherited = Object.assign(
        Object.create({ [key]: key === "from" ? "package.json" : "secret" }),
        { marker: true },
      );

      await expect(
        resolveSandbox({
          home: { files: { credential: inherited } },
          runtime: "trusted-host",
        }, {}),
      ).rejects.toThrow("requires exactly one of from or contents");
    },
  );

  it.each([
    ["from", { contents: "safe" }] as const,
    ["contents", { from: "package.json" }] as const,
  ])("rejects a declaration with inherited %s and an own alternate key", async (key, own) => {
    const value = Object.assign(Object.create({ [key]: key === "from" ? "package.json" : "secret" }), own);

    await expect(
      resolveSandbox({ home: { files: { credential: value } }, runtime: "trusted-host" }, {}),
    ).rejects.toThrow("requires exactly one of from or contents");
  });
});
