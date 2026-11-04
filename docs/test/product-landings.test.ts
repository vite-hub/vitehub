import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const docsRoot = resolve(import.meta.dirname, "../content/docs");

const landings = readdirSync(docsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `${entry.name}/index.md`)
  .filter((path) => existsSync(resolve(docsRoot, path)) && readFileSync(resolve(docsRoot, path), "utf8").includes("\n::product-hero"));

/** The lines of a top-level `::name` block, without its opening and closing lines. */
function block(source: string, name: string): string[] {
  const start = source.indexOf(`\n::${name}`);
  if (start === -1) return [];
  const lines = source.slice(start + 1).split("\n").slice(1);
  return lines.slice(0, lines.indexOf("::"));
}

/** Titles of the feature items that open while another item is still open. */
function nestedFeatureItems(source: string): string[] {
  const nested: string[] = [];
  let open = false;
  for (const line of block(source, "product-features").map((value) => value.trim())) {
    if (line.startsWith(":::product-feature-item")) {
      if (open) nested.push(line.match(/title="([^"]+)"/)?.[1] ?? line);
      open = true;
    } else if (line === ":::") {
      open = false;
    }
  }
  return nested;
}

describe("product landings", () => {
  it("finds the product landings", () => {
    expect(landings.length).toBeGreaterThan(10);
  });

  // Merges have left a second hero and stray prose inside the first one. The page then renders an empty code panel.
  it.each(landings)("%s has one hero that holds only its code", (path) => {
    const source = readFileSync(resolve(docsRoot, path), "utf8");
    expect(source.match(/^::product-hero/gm)).toHaveLength(1);
    const stray = block(source, "product-hero").filter((line) => line.trim() && !line.startsWith("  "));
    expect(stray).toEqual([]);
  });

  // An unclosed item swallows the items after it, so the list renders as one indented column.
  it.each(landings)("%s closes each feature item", (path) => {
    expect(nestedFeatureItems(readFileSync(resolve(docsRoot, path), "utf8"))).toEqual([]);
  });
});
