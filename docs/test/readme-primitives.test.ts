import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { landingPrimitives } from "../app/components/landing/content";
import { renderPrimitiveSvgs, replacePrimitivesTable } from "../scripts/primitive-svgs.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const regenerate = "Run node docs/scripts/primitive-svgs.mjs";

describe("README primitives", () => {
  it("keeps the exported scenes in sync with the landing page", async () => {
    const files = await renderPrimitiveSvgs();

    expect(files.size).toBe(landingPrimitives.length);
    for (const [path, contents] of files) {
      expect(await readFile(resolve(repoRoot, path), "utf8"), `${path}. ${regenerate}`).toBe(contents);
    }
  });

  it("keeps the README table in sync with the landing page", async () => {
    const readme = await readFile(resolve(repoRoot, "README.md"), "utf8");

    expect(replacePrimitivesTable(readme), regenerate).toBe(readme);
  });
});
