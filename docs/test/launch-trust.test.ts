import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, resolve } from "node:path";
import { object, parse, string } from "valibot";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const docsRoot = resolve(repoRoot, "docs/content/docs");
const ownedDocs = [
  resolve(docsRoot, "frameworks-hosts"),
  resolve(docsRoot, "reference"),
  resolve(docsRoot, "development"),
];

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true })
    .map((path) => resolve(directory, path.toString()))
    .filter((path) => extname(path) === ".md");
}

function routeExists(route: string): boolean {
  const relative = route.replace(/^\/docs\/?/, "").replace(/\/$/, "");
  if (!relative) return existsSync(resolve(docsRoot, "index.md"));
  return (
    existsSync(resolve(docsRoot, `${relative}.md`)) ||
    existsSync(resolve(docsRoot, relative, "index.md"))
  );
}

describe("launch documentation trust boundaries", () => {
  it("keeps canonical documentation links resolvable", () => {
    for (const file of [resolve(docsRoot, "index.md"), ...ownedDocs.flatMap(markdownFiles)]) {
      const contents = readFileSync(file, "utf8");
      const routes = [...contents.matchAll(/\]\((\/docs(?:\/[^)#\s]*)?)(?:#[^)]+)?\)/g)].map(
        (match) => match[1]!,
      );

      expect(
        routes.filter((route) => !routeExists(route)),
        file,
      ).toEqual([]);
    }
  });

  it("documents the canonical distribution and owner-package composition", () => {
    const rootReadme = readFileSync(resolve(repoRoot, "README.md"), "utf8");
    const packageReference = readFileSync(resolve(docsRoot, "reference/index.md"), "utf8");

    expect(rootReadme).toMatch(/pnpm add vite-hub/);
    expect(rootReadme).toMatch(/import \{ vitehub \} from ["']vite-hub["']/);
    expect(existsSync(resolve(docsRoot, "getting-started/migration.md"))).toBe(false);

    for (const directory of readdirSync(resolve(repoRoot, "packages"))) {
      const manifestPath = resolve(repoRoot, "packages", directory, "package.json");
      if (!existsSync(manifestPath)) continue;

      const manifest = parse(
        object({ name: string() }),
        JSON.parse(readFileSync(manifestPath, "utf8")),
      );
      expect(packageReference, manifest.name).toContain(`\`${manifest.name}\``);
    }
  });
});
