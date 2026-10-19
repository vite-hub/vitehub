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

function readOwnedDocs(): string {
  return [resolve(docsRoot, "index.md"), ...ownedDocs.flatMap(markdownFiles)]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
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
  it("publishes an inspectable host support matrix with qualified statuses", () => {
    const matrix = readFileSync(resolve(docsRoot, "frameworks-hosts/support-matrix.md"), "utf8");
    const matrixData = readFileSync(resolve(repoRoot, "docs/app/data/support-matrix.ts"), "utf8");
    const matrixComponent = readFileSync(
      resolve(repoRoot, "docs/app/components/content/SupportMatrix.vue"),
      "utf8",
    );
    const docsLayout = readFileSync(resolve(repoRoot, "docs/app/layouts/docs.vue"), "utf8");
    const docsPage = readFileSync(resolve(repoRoot, "docs/app/pages/docs/[...slug].vue"), "utf8");
    const matrixHeader = matrix.split("\n").find((line) => line.startsWith("| Contract")) ?? "";

    expect(matrixHeader).not.toBe("");
    for (const host of [
      "Local Vite",
      "Cloudflare",
      "Vercel",
      "Netlify",
      "Deno",
      "Nitro and UnJS",
      "Node and self-hosted",
    ]) {
      expect(matrixHeader).toContain(host);
    }
    expect(matrix).toMatch(
      /\| Browser\s+\| Local provider\s+\| Browser Run.*\| Local provider\s+\|/,
    );
    expect(matrixData).toContain("Browser Definitions require ViteHub's Cloudflare preset");
    expect(matrixData).toContain(
      "Pass createBrowser({ provider: localBrowser({ executablePath }) }) for a trusted local process",
    );
    expect(matrixData).toContain(
      "Pass createBrowser({ provider: localBrowser({ executablePath }) }) for a trusted self-hosted Node process",
    );
    expect(matrix).toContain(
      "Trusted local and self-hosted Node processes can call `createBrowser({ provider: localBrowser({ executablePath }) })`",
    );
    expect(matrix).toContain("Standalone `Deno.cron`");
    expect(matrixData).toContain(
      'vitehub({ preset: \\"deno\\", schedule: true }) is not supported',
    );
    expect(matrix).toContain(
      '`vitehub({ preset: "deno", schedule: true })` rejects Schedule',
    );
    expect(matrix).toContain("A production build stages the Nitro application and package-owned standalone Schedule output under `.output`");
    expect(matrix).toContain("**Available**");
    expect(matrix).toContain("**Package-specific**");
    expect(matrix).toContain("**Local-only**");
    expect(matrix).toContain("**Not provided**");
    expect(matrix).toContain("[Evidence]");
    expect(matrix).toContain("last observed 2026-08-26; stale after 30 days");
    expect(matrix).not.toContain("✓ Current");
    expect(matrix).toContain("**Not published**");
    for (const primitive of [
      "Browser",
      "Blob",
      "Database",
      "Email",
      "KV",
      "Queue",
      "Rate Limit",
      "Realtime",
      "Sandbox",
      "Schedule",
      "Workflow",
      "Workspace",
    ]) {
      expect(matrix).toMatch(new RegExp(`\\| ${primitive}\\s+\\|`));
      expect(matrixData).toContain(`label: "${primitive}"`);
    }
    expect(matrix).toContain("Cloudflare Queues");
    expect(matrix).toContain("Vercel Queues");
    expect(matrix).toMatch(/\| Queue\s+\|[^\n]+\| Cloudflare or Vercel \| —\s+\|/);
    expect(matrixData).toContain(
      "Cloudflare Queue bindings or the Vercel Queues runtime client can be composed through Nitro output",
    );
    expect(matrix).toContain("Discovery only");
    expect(matrix).toContain("Netlify requires an explicit Cloudflare or Vercel Queue Provider");
    expect(matrix).toContain("every other host requires the explicit built-in Resend driver or a programmatic custom driver");
    expect(matrix).toContain("distributed Vercel, Netlify, and Deno presets reject memory");
    expect(matrixData).toContain(
      "The Cloudflare preset supports the built-in Cloudflare Email driver default",
    );
    expect(matrixData).toContain(
      "Cloudflare Durable Objects provide the production room authority",
    );
    expect(matrixData).toContain(
      "Uses Cloudflare Sandbox or Vercel Sandbox when selected by the Nitro host",
    );
    expect(matrixData).toContain(
      "Netlify can use an explicitly selected Vercel Sandbox provider with Vercel credentials",
    );
    expect(matrix).toMatch(
      /\| Sandbox\s+\|[^\n]+\| Vercel Sandbox\s+\| —\s+\| Cloudflare or Vercel \| Sandbox provider\s+\|/,
    );
    expect(matrix).toContain(
      "the Cloudflare Sandbox provider requires a Cloudflare binding and cannot run on Netlify",
    );
    expect(matrix).toContain("Cloudflare Workflows");
    expect(matrix).toContain("Vercel Workflow");
    expect(matrix).toContain(
      "Blob, Database, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace",
    );
    expect(matrix).toContain(
      "Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory`",
    );
    // The page is a normal docs article. The Markdown tables are the text version of the matrix.
    expect(matrix).toMatch(/::support-matrix\n[\s\S]*\| Primitive[\s\S]*\| Contract[\s\S]*\n::\n/);
    expect(matrix).toContain("## Qualifications");
    expect(matrixComponent).toContain('<div class="hidden"><slot /></div>');
    expect(matrixComponent).toContain("supportMatrixGroups");
    expect(matrixComponent).toContain("tipCell.display");
    expect(matrixComponent).toContain("tipCell.detail");
    expect(docsLayout).not.toContain("support-matrix");
    expect(docsPage).not.toContain("SupportMatrix");
  });

  it("keeps launch-facing docs free from stale version and internal process prose", () => {
    const docs = readOwnedDocs();

    expect(docs).not.toMatch(/0\.0\.2 preview/i);
    expect(docs).not.toMatch(/Current docs shape|sidebar should/i);
    expect(docs).not.toMatch(/\| Planned \||boundary remains unresolved/i);
    expect(docs).not.toContain("/Users/maxi/");
  });

  it("keeps Agent Evals on its canonical Agent page", () => {
    const docs = readOwnedDocs();

    expect(existsSync(resolve(docsRoot, "development/agent-evals.md"))).toBe(false);
    expect(docs).not.toContain("/docs/development/agent-evals");
  });

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

  it("records current preset and discovery defaults", () => {
    const config = readFileSync(resolve(docsRoot, "reference/config-options.md"), "utf8");
    const conventions = readFileSync(resolve(docsRoot, "reference/file-conventions.md"), "utf8");

    expect(config).toContain("`vitehub()` requires exactly one built-in `preset`");
    expect(config).toContain(
      "Email accepts `true` with the Cloudflare preset, where it selects the Cloudflare Email driver; other presets reject that boolean default and require explicit provider options.",
    );
    expect(config).toContain("Netlify does not infer a provider");
    expect(conventions).toContain("`server/databases/<name>/config.ts`");
    expect(conventions).toContain("`<path>.agent.ts`");
    expect(conventions).toContain("`server/workspaces/<name>/config.ts`");
  });
});
