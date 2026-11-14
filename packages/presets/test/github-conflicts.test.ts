import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { commitGitHubPullRequestWorkspace, prepareGitHubRepairBase } from "../src/github/repair.ts";

// Each case builds and merges real Git repositories, which takes seconds on a loaded host.
vi.setConfig({ testTimeout: 30_000 });
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
const commit = async (cwd: string, message: string) => {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message);
  return await git(cwd, "rev-parse", "HEAD");
};
const json = (value: unknown, indent: string | number = 2) => `${JSON.stringify(value, null, indent)}\n`;
type Files = Record<string, string>;
const write = async (root: string, files: Files) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

/** A repository whose PR branch `repair` and base branch `main` both changed `base`. */
async function conflict(base: Files, pr: Files, main: Files, setup?: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-host-conflicts-")); roots.push(root);
  await git(root, "init", "-q", "-b", "repair");
  await write(root, base);
  await setup?.(root);
  await commit(root, "base");
  await git(root, "checkout", "-q", "-b", "main");
  await write(root, main);
  await setup?.(root);
  const baseSha = await commit(root, "main change");
  await git(root, "checkout", "-q", "repair");
  await write(root, pr);
  await setup?.(root);
  const expectedHead = await commit(root, "PR change");
  return { root, expectedHead, base: baseSha };
}

const noLockfile = { regenerateLockfile: false } as const;

it("merges independent package.json key changes and keeps the file's indentation", async () => {
  const manifest = { name: "a", version: "0.1.0", scripts: { build: "vp pack", test: "vp test" }, peerDependencies: { vite: "^7.0.0", "drizzle-orm": "^1.0.0" } };
  const { root, expectedHead, base } = await conflict(
    { "packages/a/package.json": json(manifest, "\t") },
    { "packages/a/package.json": json({ ...manifest, version: "0.2.0", peerDependencies: { ...manifest.peerDependencies, vite: "^8.0.0" } }, "\t") },
    { "packages/a/package.json": json({ name: "a", version: "0.1.0", imports: { "#a": "./a.js" }, scripts: { ...manifest.scripts, test: "vp test --run" }, peerDependencies: { ...manifest.peerDependencies, "drizzle-orm": "^1.1.0" } }, "\t") },
  );
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile });
  expect(result).toEqual({ conflicted: ["packages/a/package.json"], resolved: [{ path: "packages/a/package.json", rule: "package-json" }], remaining: [] });
  const merged = await readFile(join(root, "packages/a/package.json"), "utf8");
  expect(merged).toBe(json({ name: "a", version: "0.2.0", imports: { "#a": "./a.js" }, scripts: { build: "vp pack", test: "vp test --run" }, peerDependencies: { vite: "^8.0.0", "drizzle-orm": "^1.1.0" } }, "\t"));
  expect(await git(root, "diff", "--name-only", "--diff-filter=U")).toBe("");
  expect(await git(root, "show", ":packages/a/package.json")).toBe(merged.trimEnd());
});

it.each([
  ["the same key changed differently", { scripts: { test: "vp test --pr" } }, { scripts: { test: "vp test --main" } }],
  // Merged key by key these would be independent, but condition order decides which file loads.
  ["export conditions changed on both sides", { exports: { ".": { types: "./a.d.ts", import: "./a.js" } } }, { exports: { ".": { import: "./a.js", default: "./a.cjs" } } }],
  ["an array changed on both sides", { files: ["dist", "pr"] }, { files: ["dist", "main"] }],
])("leaves package.json conflicted when %s", async (_, pr, main) => {
  const manifest = { name: "a", scripts: { test: "vp test" }, exports: { ".": { import: "./a.js" } }, files: ["dist"] };
  const { root, expectedHead, base } = await conflict(
    { "package.json": json(manifest) },
    { "package.json": json({ ...manifest, ...pr }) },
    { "package.json": json({ ...manifest, ...main }) },
  );
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile });
  expect(result).toEqual({ conflicted: ["package.json"], resolved: [], remaining: ["package.json"] });
  expect(await readFile(join(root, "package.json"), "utf8")).toContain("<<<<<<<");
  expect(await git(root, "diff", "--name-only", "--diff-filter=U")).toBe("package.json");
});

it("leaves a package.json that would be reformatted for the model", async () => {
  const { root, expectedHead, base } = await conflict(
    { "package.json": '{\n  "name": "a",\n  "version": "1.0.0",\n  "files": ["dist"]\n}\n' },
    { "package.json": '{\n  "name": "a",\n  "version": "1.1.0",\n  "files": ["dist"]\n}\n' },
    { "package.json": '{\n  "name": "b",\n  "version": "1.0.0",\n  "files": ["dist"]\n}\n' },
  );
  // Git conflicts on the adjacent lines; rewriting the inline array would add unrelated changes.
  expect((await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile }))?.remaining).toEqual(["package.json"]);
});

it("keeps both sides of Markdown docs where both only added lines, base text first", async () => {
  const doc = "# Guide\n\nIntro.\n\n## Options\n\n- first\n\n## End\n";
  const { root, expectedHead, base } = await conflict(
    { "docs/content/guide.md": doc, "packages/a/README.md": doc },
    { "docs/content/guide.md": doc.replace("- first\n", "- first\n- from the PR\n"), "packages/a/README.md": doc.replace("- first\n", "- first\n- from the PR\n") },
    { "docs/content/guide.md": doc.replace("- first\n", "- first\n- from main\n- also main\n"), "packages/a/README.md": doc.replace("- first\n", "- first\n- from main\n") },
  );
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile });
  expect(result?.resolved).toEqual([{ path: "docs/content/guide.md", rule: "markdown-union" }, { path: "packages/a/README.md", rule: "markdown-union" }]);
  expect(await readFile(join(root, "docs/content/guide.md"), "utf8")).toBe(doc.replace("- first\n", "- first\n- from main\n- also main\n- from the PR\n"));
  expect(await readFile(join(root, "packages/a/README.md"), "utf8")).toBe(doc.replace("- first\n", "- first\n- from main\n- from the PR\n"));
});

it.each([
  ["near-duplicate sentences", "> [!NOTE]\n> The live editor was removed. The hosted Console edits with the edit lease.\n", "> [!NOTE]\n> The live editor was removed. The Console edits with the edit lease.\n"],
  ["the same heading", "## Seed\n\nRun the PR seed.\n", "## Seed\n\nRun the base seed.\n"],
])("leaves Markdown additions that compete as %s for the model", async (_, pr, main) => {
  const doc = "# Guide\n\nIntro.\n";
  const { root, expectedHead, base } = await conflict({ "docs/guide.md": doc }, { "docs/guide.md": `${doc}\n${pr}` }, { "docs/guide.md": `${doc}\n${main}` });
  expect((await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile }))?.remaining).toEqual(["docs/guide.md"]);
});

it.each([
  ["frontmatter", "---\ntitle: A\n---\n\n# A\n", "title: A\n", "title: A\nlayout: landing\n", "title: A\nlayout: page\n"],
  ["a fenced code block", "# Run\n\n```sh\n```\n", "```sh\n", "```sh\ncp source target\n", "```sh\nrm source\n"],
  ["a table", "# Options\n\n| Key | Value |\n| --- | --- |\n| a | 1 |\n", "| a | 1 |\n", "| a | 1 |\n| retries | 3 |\n", "| a | 1 |\n| retries | 5 |\n"],
  ["an MDC component", "# Tip\n\n::tip\nRead this.\n::\n", "Read this.\n", "Read this.\nThe PR way.\n", "Read this.\nThe main way.\n"],
])("leaves Markdown additions inside %s for the model", async (_, doc, anchor, pr, main) => {
  const { root, expectedHead, base } = await conflict({ "docs/guide.md": doc }, { "docs/guide.md": doc.replace(anchor, pr) }, { "docs/guide.md": doc.replace(anchor, main) });
  expect((await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile }))?.remaining).toEqual(["docs/guide.md"]);
});

it("keeps both sides of new sections that bring their own code blocks and tables", async () => {
  const doc = "# CLI\n\nIntro.\n";
  const section = (name: string) => `\n## ${name}\n\n\`\`\`bash\npnpm ${name}\n\`\`\`\n\n| Option | Description |\n| --- | --- |\n| --${name} | Run ${name}. |\n`;
  const { root, expectedHead, base } = await conflict({ "docs/cli.md": doc }, { "docs/cli.md": doc + section("sql") }, { "docs/cli.md": doc + section("seed") });
  expect((await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile }))?.remaining).toEqual([]);
  expect(await readFile(join(root, "docs/cli.md"), "utf8")).toBe(doc + section("seed") + section("sql"));
});

it("does not union code, Markdown outside the allowlist, or Markdown hunks that rewrote base text", async () => {
  const code = "export const a = 1\n\nexport const z = 26\n";
  const doc = "# Guide\n\n- first\n- second\n";
  const { root, expectedHead, base } = await conflict(
    { "src/a.ts": code, "notes/plan.md": doc, "docs/guide.md": doc },
    { "src/a.ts": code.replace("\n\n", "\nexport const b = 2\n\n"), "notes/plan.md": doc.replace("- second\n", "- second\n- pr\n"), "docs/guide.md": doc.replace("- second", "- second (PR)") },
    { "src/a.ts": code.replace("\n\n", "\nexport const c = 3\n\n"), "notes/plan.md": doc.replace("- second\n", "- second\n- main\n"), "docs/guide.md": doc.replace("- second", "- second (main)") },
  );
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile });
  expect(result).toEqual({ conflicted: ["docs/guide.md", "notes/plan.md", "src/a.ts"], resolved: [], remaining: ["docs/guide.md", "notes/plan.md", "src/a.ts"] });
  expect(await readFile(join(root, "src/a.ts"), "utf8")).toContain("<<<<<<<");
});

const lockfile = (body: string) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${body}\npackages:\n\n  left-pad@1.0.0:\n    resolution: {integrity: sha512-base}\n`;
const entry = (name: string, specifier: string, version: string) => `      ${name}:\n        specifier: ${specifier}\n        version: ${version}\n`;

it("leaves the lockfile conflicted when regeneration drops a resolution only the PR lockfile changed", async () => {
  const manifest = (dependencies: Record<string, string>) => json({ name: "root", dependencies });
  const regenerated: string[] = [];
  const { root, expectedHead, base } = await conflict(
    { "package.json": manifest({ foo: "^1.0.0" }), "pnpm-lock.yaml": lockfile(entry("foo", "^1.0.0", "1.0.0")) },
    // `pnpm update foo`: the lockfile moves, the manifest does not.
    { "pnpm-lock.yaml": lockfile(entry("foo", "^1.0.0", "1.0.1")) },
    { "package.json": manifest({ foo: "^1.0.0", zed: "^2.0.0" }), "pnpm-lock.yaml": lockfile(entry("foo", "^1.0.0", "1.0.0") + entry("zed", "^2.0.0", "2.0.0")) },
  );
  const conflicted = await git(root, "merge-tree", "--write-tree", "--name-only", expectedHead, base).catch((error: { stdout: string }) => error.stdout);
  expect(conflicted).toContain("pnpm-lock.yaml");
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: {
    // pnpm keeps the base's resolution while it still satisfies the manifest range.
    regenerateLockfile: async target => { regenerated.push(await readFile(join(target, "pnpm-lock.yaml"), "utf8")); return regenerated[0]!; },
  } });
  expect(regenerated).toEqual([lockfile(entry("foo", "^1.0.0", "1.0.0") + entry("zed", "^2.0.0", "2.0.0"))]);
  expect(result).toMatchObject({ conflicted: ["pnpm-lock.yaml"], resolved: [], remaining: ["pnpm-lock.yaml"], lockfile: expect.stringContaining(". dependencies foo") });
  expect(await readFile(join(root, "pnpm-lock.yaml"), "utf8")).toContain("<<<<<<<");
  expect(await git(root, "diff", "--name-only", "--diff-filter=U")).toBe("pnpm-lock.yaml");
});

it.each(["base", "pr"] as const)("leaves the lockfile conflicted when both sides moved a dependency edge (regeneration keeps the %s edge)", async kept => {
  const x = (version: string) => `      x${version.at(-1)}:\n        specifier: npm:x@${version}\n        version: x@${version}\n`;
  const graph = (edge: string) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${entry("foo", "1.0.0", "1.0.0")}${x("1.0.0")}${x("1.0.1")}${x("1.0.2")}
packages:\n\n  foo@1.0.0:\n    resolution: {integrity: sha512-foo}\n\n  x@1.0.0:\n    resolution: {integrity: sha512-x0}\n\n  x@1.0.1:\n    resolution: {integrity: sha512-x1}\n\n  x@1.0.2:\n    resolution: {integrity: sha512-x2}
\nsnapshots:\n\n  foo@1.0.0:\n    dependencies:\n      x: ${edge}\n\n  x@1.0.0: {}\n\n  x@1.0.1: {}\n\n  x@1.0.2: {}\n`;
  const manifest = json({ name: "root", dependencies: { foo: "1.0.0", x0: "npm:x@1.0.0", x1: "npm:x@1.0.1", x2: "npm:x@1.0.2" } });
  const { root, expectedHead, base } = await conflict(
    { "package.json": manifest, "pnpm-lock.yaml": graph("1.0.0") },
    { "pnpm-lock.yaml": graph("1.0.1") },
    { "pnpm-lock.yaml": graph("1.0.2") },
  );
  // pnpm keeps the base lockfile's edge: every version is still in the graph and satisfies foo.
  // Keeping the PR's edge instead would drop the base's choice, so that also needs the model.
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: { regenerateLockfile: async target => kept === "base" ? await readFile(join(target, "pnpm-lock.yaml"), "utf8") : graph("1.0.1") } });
  expect(result).toMatchObject({ resolved: [], remaining: ["pnpm-lock.yaml"], lockfile: expect.stringContaining("foo@1.0.0 dependencies x") });
  expect(await readFile(join(root, "pnpm-lock.yaml"), "utf8")).toContain("<<<<<<<");
});

it("regenerates the lockfile when the PR moved an edge of a package the base removed from the graph", async () => {
  const graph = (edges: string) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${edges ? entry("foo", "1.0.0", "1.0.0") : ""}${entry("x", "1.0.0", "1.0.0")}
packages:\n\n${edges ? "  foo@1.0.0:\n    resolution: {integrity: sha512-foo}\n\n" : ""}  x@1.0.0:\n    resolution: {integrity: sha512-x0}
\nsnapshots:\n\n${edges}  x@1.0.0: {}\n`;
  const { root, expectedHead, base } = await conflict(
    { "package.json": json({ name: "root", dependencies: { foo: "1.0.0", x: "1.0.0" } }), "pnpm-lock.yaml": graph("  foo@1.0.0:\n    dependencies:\n      x: 1.0.0\n\n") },
    { "pnpm-lock.yaml": graph("  foo@1.0.0:\n    dependencies:\n      x: 1.0.0\n    optionalDependencies:\n      y: 2.0.0\n\n") },
    { "package.json": json({ name: "root", dependencies: { x: "1.0.0" } }), "pnpm-lock.yaml": graph("") },
  );
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: { regenerateLockfile: async target => await readFile(join(target, "pnpm-lock.yaml"), "utf8") } });
  expect(result).toMatchObject({ resolved: [{ path: "pnpm-lock.yaml", rule: "pnpm-lockfile" }], remaining: [] });
});

it("leaves a lockfile that depends on a pnpmfile for the model", async () => {
  let called = false;
  const hooked = (body: string) => lockfile(body).replace("lockfileVersion: '9.0'\n", "lockfileVersion: '9.0'\n\npnpmfileChecksum: sha256-hook\n");
  const { root, expectedHead, base } = await conflict(
    { "package.json": json({ name: "root", dependencies: { foo: "^1.0.0" } }), "pnpm-lock.yaml": hooked(entry("foo", "^1.0.0", "1.0.0")) },
    { "pnpm-lock.yaml": hooked(entry("foo", "^1.0.0", "1.0.1")) },
    { "pnpm-lock.yaml": hooked(entry("foo", "^1.0.0", "1.0.2")) },
  );
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: { regenerateLockfile: async () => { called = true; return ""; } } });
  expect(called).toBe(false);
  expect(result).toMatchObject({ remaining: ["pnpm-lock.yaml"], lockfile: expect.stringContaining("pnpmfile") });
});

it("does not regenerate the lockfile while a package.json stays conflicted", async () => {
  let called = false;
  const { root, expectedHead, base } = await conflict(
    { "package.json": json({ name: "root", dependencies: { foo: "^1.0.0" } }), "pnpm-lock.yaml": lockfile(entry("foo", "^1.0.0", "1.0.0")) },
    { "package.json": json({ name: "root", dependencies: { foo: "^1.1.0" } }), "pnpm-lock.yaml": lockfile(entry("foo", "^1.1.0", "1.1.0")) },
    { "package.json": json({ name: "root", dependencies: { foo: "^1.2.0" } }), "pnpm-lock.yaml": lockfile(entry("foo", "^1.2.0", "1.2.0")) },
  );
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: { regenerateLockfile: async () => { called = true; return ""; } } });
  expect(called).toBe(false);
  expect(result).toMatchObject({ resolved: [], remaining: ["package.json", "pnpm-lock.yaml"], lockfile: "dependency inputs remain conflicted: package.json" });
});

it("accepts host-staged resolutions in commitRepair and records a two-parent merge", async () => {
  const manifest = { name: "a", version: "1.0.0", dependencies: { x: "1.0.0" } };
  const { root, expectedHead, base } = await conflict(
    { "package.json": json(manifest), "file.txt": "before\n" },
    { "package.json": json({ ...manifest, version: "1.1.0" }), "file.txt": "PR\n" },
    { "package.json": json({ ...manifest, name: "b", dependencies: { x: "1.0.0", y: "2.0.0" } }), "file.txt": "main\n" },
  );
  const result = await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile });
  expect(result).toEqual({ conflicted: ["file.txt", "package.json"], resolved: [{ path: "package.json", rule: "package-json" }], remaining: ["file.txt"] });
  expect(JSON.parse(await readFile(join(root, ".git", "vitehub-merge.json"), "utf8")).conflicts).toEqual(result);
  await expect(commitGitHubPullRequestWorkspace(root, { message: "merge", paths: ["package.json"] }, { expectedHead })).rejects.toThrow(/file.txt/);
  await writeFile(join(root, "file.txt"), "both\n");
  const head = await commitGitHubPullRequestWorkspace(root, { message: "merge main", paths: ["file.txt"] }, { expectedHead });
  expect(await git(root, "rev-parse", `${head}^1`, `${head}^2`)).toBe(`${expectedHead}\n${base}`);
  expect(JSON.parse(await git(root, "show", `${head}:package.json`))).toEqual({ name: "b", version: "1.1.0", dependencies: { x: "1.0.0", y: "2.0.0" } });
  expect(await git(root, "status", "--porcelain")).toBe("");
});

it("commits a merge the host resolved completely when the model passes the resolved paths", async () => {
  const doc = "# A\n\n- one\n";
  const { root, expectedHead, base } = await conflict({ "docs/a.md": doc }, { "docs/a.md": `${doc}- pr\n` }, { "docs/a.md": `${doc}- main\n` });
  expect((await prepareGitHubRepairBase(root, { expectedHead, base, conflicts: noLockfile }))?.remaining).toEqual([]);
  const head = await commitGitHubPullRequestWorkspace(root, { message: "merge main", paths: ["docs/a.md"] }, { expectedHead });
  expect(await git(root, "show", `${head}:docs/a.md`)).toBe(`${doc}- main\n- pr`);
  expect(await git(root, "rev-parse", `${head}^2`)).toBe(base);
});

const pnpm = await exec("sh", ["-c", "command -v pnpm"]).then(result => result.stdout.trim(), () => "");

it.runIf(pnpm)("regenerates a conflicted pnpm lockfile through the protected installer and passes a frozen install", async () => {
  const pkg = (name: string, extra: Record<string, unknown> = {}) => json({ name, version: "1.0.0", private: true, ...extra });
  const workspace = { ".gitignore": "node_modules\n", "package.json": pkg("root"), "pnpm-workspace.yaml": "packages:\n  - packages/*\n", "packages/b/package.json": pkg("b"), "packages/c/package.json": pkg("c"), "packages/d/package.json": pkg("d"), "packages/e/package.json": pkg("e") };
  const lock = async (root: string) => { await exec(pnpm, ["install", "--lockfile-only", "--ignore-scripts"], { cwd: root }); };
  // package.json merges cleanly in Git; only the lockfile importer entries meet.
  const { root, expectedHead, base } = await conflict(
    { ...workspace, "packages/a/package.json": pkg("a", { dependencies: { d: "workspace:*" }, license: "MIT" }) },
    { "packages/a/package.json": pkg("a", { dependencies: { d: "workspace:*", e: "workspace:*" }, license: "MIT" }) },
    { "packages/a/package.json": pkg("a", { dependencies: { d: "workspace:*" }, license: "MIT", devDependencies: { c: "workspace:*" } }) },
    lock,
  );
  const bin = await mkdtemp(join(tmpdir(), "vitehub-host-conflicts-bin-")); roots.push(bin);
  // Stands in for Corepack: records the protected arguments, then runs this host's pnpm.
  await writeFile(join(bin, "corepack"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args.txt"\nshift\nCOREPACK_HOME="${process.env.COREPACK_HOME ?? join(homedir(), ".cache/node/corepack")}" exec "${pnpm}" "$@"\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  let result;
  try {
    process.env.PATH = `${bin}:${previousPath}`;
    result = await prepareGitHubRepairBase(root, { expectedHead, base });
  } finally { process.env.PATH = previousPath; }
  expect(result).toEqual({ conflicted: ["pnpm-lock.yaml"], resolved: [{ path: "pnpm-lock.yaml", rule: "pnpm-lockfile" }], remaining: [] });
  expect((await readFile(join(bin, "args.txt"), "utf8")).split("\n")).toEqual(expect.arrayContaining(["install", "--lockfile-only", "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false"]));
  const lockText = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  expect(lockText).not.toContain("<<<<<<<");
  expect(lockText).toMatch(/e:\n\s+specifier: workspace:\*\n\s+version: link:\.\.\/e/);
  expect(lockText).toMatch(/c:\n\s+specifier: workspace:\*\n\s+version: link:\.\.\/c/);
  await exec(pnpm, ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"], { cwd: root });
  const head = await commitGitHubPullRequestWorkspace(root, { message: "merge main", paths: ["pnpm-lock.yaml"] }, { expectedHead });
  expect(await git(root, "rev-parse", `${head}^2`)).toBe(base);
}, 60_000);
