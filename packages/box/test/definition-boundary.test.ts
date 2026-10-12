import { describe, expect, it } from "vitest";

import { resolveBox } from "../src/index.ts";

describe("Box definition boundaries", () => {
  it.each(["from", "contents"] as const)(
    "rejects file declarations with inherited %s",
    async (key) => {
      const inherited = Object.assign(
        Object.create({ [key]: key === "from" ? "package.json" : "secret" }),
        { marker: true },
      );

      await expect(
        resolveBox({
          home: { files: { credential: inherited } },
          runtime: "trusted-host",
        }, {}),
      ).rejects.toThrow("requires exactly one of from or contents");
    },
  );
});
