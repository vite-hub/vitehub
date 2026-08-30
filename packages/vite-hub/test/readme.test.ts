import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

describe("framework package README", () => {
  it("keeps host support in the canonical guide", () => {
    expect(readme).toContain(
      "[Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)",
    );
    expect(readme).not.toMatch(/\| Preset\s+\| Blob/);
  });
});
