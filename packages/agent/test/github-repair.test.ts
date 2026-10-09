import { execFile } from "node:child_process";
import * as filesystem from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { commitGitHubPullRequestWorkspace, prepareGitHubRepairBase } from "../src/server/github-repair.ts";
import { assertGitHubDependenciesCurrent } from "../src/server/github-install.ts";
import { validateGitHubInstallInputs } from "../src/server/github-install-inputs.ts";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), open: vi.fn(actual.open) };
});

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-host-repair-")); roots.push(root);
  await git(root, "init", "-b", "repair");
  await writeFile(join(root, "file.txt"), "before\n");
  await writeFile(join(root, "unrelated.txt"), "keep\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base");
  return { root, expectedHead: await git(root, "rev-parse", "HEAD") };
}

it("commits selected repair files on the exact ancestry without running checkout hooks", async () => {
  const { root, expectedHead } = await fixture();
  await writeFile(join(root, "file.txt"), "repair\n");
  await writeFile(join(root, "unrelated.txt"), "unrelated edit\n");
  await writeFile(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const head = await commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["file.txt"] }, { expectedHead });
  expect(await git(root, "rev-parse", `${head}^`)).toBe(expectedHead);
  expect(await git(root, "show", `${head}:file.txt`)).toBe("repair");
  expect(await git(root, "show", `${head}:unrelated.txt`)).toBe("keep");
  expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("unrelated edit\n");
});

it.each(["link", "portal"])("commits after a successful refresh with ignored build outputs in a %s dependency", async protocol => {
  const { root } = await fixture();
  await mkdir(join(root, "packages/local/src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "repair", dependencies: { local: `${protocol}:packages/local` } }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages: ['packages/*']\n");
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await writeFile(join(root, "packages/local/package.json"), JSON.stringify({ name: "local", version: "1.0.0", bin: "dist/cli.js" }));
  await writeFile(join(root, "packages/local/src/index.js"), "export const value = 1;\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "linked workspace");
  const expectedHead = await git(root, "rev-parse", "HEAD");
  await mkdir(join(root, "packages/local/dist"));
  await writeFile(join(root, "packages/local/dist/index.js"), "export const value = 1;\n");
  await writeFile(join(root, "packages/local/dist/cli.js"), "#!/usr/bin/env node\nconsole.log('cli');\n");
  // A successful host refresh records the installed working-tree inputs.
  await writeFile(join(root, ".git/vitehub-install.json"), JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  await writeFile(join(root, "file.txt"), "repair\n");
  const head = await commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["file.txt"] }, { expectedHead, verifyDependencies: true });
  expect(await git(root, "rev-parse", `${head}^`)).toBe(expectedHead);
  expect(await git(root, "show", `${head}:file.txt`)).toBe("repair");
  expect(await git(root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain("dist/index.js");
});

it.each([
  { protocol: "link", bin: "cli.js" },
  { protocol: "portal", bin: { local: "cli.js" } },
])("invalidates installed command shims when a $protocol package's bin target changes", async ({ protocol, bin }) => {
  const { root } = await fixture();
  const local = join(root, "packages/local");
  await mkdir(local, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { local: `${protocol}:packages/local` } }));
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "local", bin }));
  await writeFile(join(local, "source.js"), "export const value = 1;\n");
  await writeFile(join(local, "cli.js"), "#!/usr/bin/env node\nconsole.log('cli');\n");
  const record = join(root, ".git/vitehub-install.json");
  const installed = await validateGitHubInstallInputs(root);
  await writeFile(record, JSON.stringify({ status: "installed", fingerprint: installed }));
  await writeFile(join(local, "source.js"), "export const value = 2;\n");
  await expect(assertGitHubDependenciesCurrent(root)).resolves.toBeUndefined();
  await writeFile(join(local, "cli.js"), "#!/bin/sh\nprintf cli\n");
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow("Dependency inputs changed");
  await writeFile(record, JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  await chmod(join(local, "cli.js"), 0o755);
  await expect(assertGitHubDependenciesCurrent(root)).rejects.toThrow("Dependency inputs changed");
});

it("keeps tracked linked command deletions behind the installation fence", async () => {
  const { root } = await fixture();
  const local = join(root, "packages/local");
  await mkdir(local, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { local: "link:packages/local" } }));
  await writeFile(join(local, "package.json"), JSON.stringify({ name: "local", bin: "cli.js" }));
  await writeFile(join(local, "cli.js"), "#!/usr/bin/env node\nconsole.log('cli');\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "linked command");
  const expectedHead = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, ".git/vitehub-install.json"), JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  await rm(join(local, "cli.js"));
  await expect(commitGitHubPullRequestWorkspace(root, { message: "remove command", paths: ["packages/local/cli.js"] }, { expectedHead, verifyDependencies: true })).rejects.toThrow("Dependency inputs changed");
  expect(await git(root, "rev-parse", "HEAD")).toBe(expectedHead);
});

it("refreshes reused generated command snapshots and detects a required dependency refresh", async () => {
  const { root } = await fixture();
  const command = "packages/local/dist/cli.js";
  await mkdir(join(root, "packages/local/dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { local: "link:packages/local" } }));
  await writeFile(join(root, "packages/local/package.json"), JSON.stringify({ name: "local", bin: "dist/cli.js" }));
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "linked command");
  await writeFile(join(root, command), "first generated command\n");
  const record = join(root, ".git/vitehub-install.json");
  await writeFile(record, JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  const inputs = await mkdtemp(join(tmpdir(), "vitehub-bin-snapshot-")); roots.push(inputs);
  await git(root, "checkout-index", "--all", `--prefix=${inputs}/`);
  await assertGitHubDependenciesCurrent(root, inputs);
  await writeFile(join(root, command), "second generated command\n");
  await expect(assertGitHubDependenciesCurrent(root, inputs)).rejects.toThrow("Dependency inputs changed");
  expect(await readFile(join(inputs, command), "utf8")).toBe("second generated command\n");
  await writeFile(record, JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  await expect(assertGitHubDependenciesCurrent(root, inputs)).resolves.toBeUndefined();
  await rm(join(root, command));
  await expect(assertGitHubDependenciesCurrent(root, inputs)).rejects.toThrow("Dependency inputs changed");
  await expect(readFile(join(inputs, command))).rejects.toMatchObject({ code: "ENOENT" });
});

it("validates a newly indexed linked command from its protected snapshot instead of changed worktree bytes", async () => {
  const { root } = await fixture();
  const command = "packages/local/cli.js";
  await mkdir(join(root, "packages/local"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { local: "link:packages/local" } }));
  await writeFile(join(root, "packages/local/package.json"), JSON.stringify({ name: "local", bin: "cli.js" }));
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "linked command declaration");
  await writeFile(join(root, command), "indexed command\n");
  await git(root, "add", command);
  await writeFile(join(root, command), "different live command\n");
  const record = join(root, ".git/vitehub-install.json");
  await writeFile(record, JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  const inputs = await mkdtemp(join(tmpdir(), "vitehub-bin-index-")); roots.push(inputs);
  await git(root, "checkout-index", "--all", `--prefix=${inputs}/`);
  await expect(assertGitHubDependenciesCurrent(root, inputs)).rejects.toThrow("Dependency inputs changed");
  expect(await readFile(join(inputs, command), "utf8")).toBe("indexed command\n");
  await writeFile(record, JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(inputs) }));
  await expect(assertGitHubDependenciesCurrent(root, inputs)).resolves.toBeUndefined();
  expect(await readFile(join(inputs, command), "utf8")).toBe("indexed command\n");
});

it.each(["parent", "open"])("rejects generated command %s replacement before copying into the protected snapshot", async race => {
  const { root } = await fixture();
  const command = "packages/local/dist/cli.js";
  await mkdir(join(root, "packages/local/dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { local: "link:packages/local" } }));
  await writeFile(join(root, "packages/local/package.json"), JSON.stringify({ name: "local", bin: "dist/cli.js" }));
  await writeFile(join(root, ".gitignore"), "dist/\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "linked command");
  await writeFile(join(root, command), "safe generated command\n");
  await writeFile(join(root, ".git/vitehub-install.json"), JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  const inputs = await mkdtemp(join(tmpdir(), "vitehub-bin-snapshot-")); roots.push(inputs);
  await git(root, "checkout-index", "--all", `--prefix=${inputs}/`);
  const outside = await mkdtemp(join(tmpdir(), "vitehub-bin-outside-")); roots.push(outside);
  await writeFile(join(outside, "cli.js"), "outside host content\n");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let replaced = false;
  const replace = async () => {
    replaced = true;
    await filesystem.rename(join(root, "packages/local/dist"), join(root, "packages/local/original-dist"));
    await symlink(outside, join(root, "packages/local/dist"));
  };
  const mkdirSpy = vi.spyOn(filesystem, "mkdir").mockImplementation(async (path, options) => {
    if (race === "parent" && String(path) === join(inputs, "packages/local/dist")) await replace();
    // SAFETY: The intercepted call uses the recursive mkdir overload.
    return await actual.mkdir(path, options as { recursive: true });
  });
  const openSpy = vi.spyOn(filesystem, "open").mockImplementation(async (path, flags, mode) => {
    if (race === "open" && String(path) === join(root, command)) await replace();
    return await actual.open(path, flags, mode);
  });
  try {
    await expect(assertGitHubDependenciesCurrent(root, inputs)).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(await readFile(join(inputs, command), "utf8").catch(() => "")).not.toContain("outside host content");
  } finally { mkdirSpy.mockRestore(); openSpy.mockRestore(); }
});

it("fingerprints missing linked commands and rejects symbolic or metadata command targets", async () => {
  const { root } = await fixture();
  const local = join(root, "packages/local");
  await mkdir(local, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { local: "link:packages/local" } }));
  const manifest = join(local, "package.json");
  await writeFile(manifest, JSON.stringify({ name: "local", bin: "cli.js" }));
  const missing = await validateGitHubInstallInputs(root);
  await writeFile(join(local, "cli.js"), "#!/usr/bin/env node\n");
  expect(await validateGitHubInstallInputs(root)).not.toBe(missing);
  await rm(join(local, "cli.js"));
  await symlink("package.json", join(local, "cli.js"));
  await expect(validateGitHubInstallInputs(root)).rejects.toThrow("regular files");
  await writeFile(manifest, JSON.stringify({ name: "local", bin: "../../.git/config" }));
  await expect(validateGitHubInstallInputs(root)).rejects.toThrow("Git metadata");
});

it.each([false, true])("stages an explicitly restored instruction file marked skip-worktree, preparedMerge=%s", async preparedMerge => {
  const { root } = await fixture();
  await writeFile(join(root, "AGENTS.md"), "Original PR instructions\n");
  await git(root, "add", "AGENTS.md");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "track instructions");
  const expectedHead = await git(root, "rev-parse", "HEAD");
  let base: string | undefined;
  if (preparedMerge) {
    await git(root, "checkout", "-b", "main");
    await writeFile(join(root, "base-only.txt"), "Live base addition\n");
    await git(root, "add", "base-only.txt");
    await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "advance base");
    base = await git(root, "rev-parse", "HEAD");
    await git(root, "checkout", "repair");
    await prepareGitHubRepairBase(root, { expectedHead, base });
  }
  await git(root, "update-index", "--skip-worktree", "AGENTS.md");
  await writeFile(join(root, "AGENTS.md"), "Restored PR repair instructions\n");
  await writeFile(join(root, "unrelated.txt"), "Unrelated local edit\n");
  const head = await commitGitHubPullRequestWorkspace(root, { message: "restore reviewed instructions", paths: ["AGENTS.md"] }, { expectedHead });
  expect(await git(root, "show", `${head}:AGENTS.md`)).toBe("Restored PR repair instructions");
  expect(await git(root, "rev-parse", `${head}^1`)).toBe(expectedHead);
  if (base) expect(await git(root, "rev-parse", `${head}^2`)).toBe(base);
  expect(await git(root, "show", `${head}:unrelated.txt`)).toBe("keep");
  expect(await readFile(join(root, "unrelated.txt"), "utf8")).toBe("Unrelated local edit\n");
});

it.each(["../outside", "/tmp/outside", ".git/config", ".", "./", "a/../../outside"])("rejects unsafe repair path %s", async path => {
  const { root, expectedHead } = await fixture();
  await expect(commitGitHubPullRequestWorkspace(root, { message: "repair", paths: [path] }, { expectedHead })).rejects.toThrow(/paths/);
  expect(await git(root, "rev-parse", "HEAD")).toBe(expectedHead);
});

it("rejects changed ancestry and pre-existing staged changes", async () => {
  const { root, expectedHead } = await fixture();
  await writeFile(join(root, "file.txt"), "repair\n");
  await git(root, "add", "file.txt");
  await expect(commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["file.txt"] }, { expectedHead })).rejects.toThrow(/staged/);
  await git(root, "reset");
  await git(root, "checkout", "--orphan", "unrelated");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "orphan");
  await expect(commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["file.txt"] }, { expectedHead })).rejects.toThrow();
});

it("prepares and commits a conflicting exact-base merge through host tools", async () => {
  const { root } = await fixture();
  await git(root, "checkout", "-b", "main");
  await writeFile(join(root, "file.txt"), "base edit\n");
  await writeFile(join(root, "base-only.txt"), "base addition\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "base change");
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "checkout", "repair");
  await writeFile(join(root, "file.txt"), "PR edit\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "PR change");
  const expectedHead = await git(root, "rev-parse", "HEAD");
  await prepareGitHubRepairBase(root, { expectedHead, base });
  expect(await readFile(join(root, "file.txt"), "utf8")).toContain("<<<<<<<");
  await writeFile(join(root, "file.txt"), "combined edit\n");
  const head = await commitGitHubPullRequestWorkspace(root, { message: "merge base and resolve conflict", paths: ["file.txt"] }, { expectedHead });
  expect(await git(root, "rev-parse", `${head}^1`)).toBe(expectedHead);
  expect(await git(root, "rev-parse", `${head}^2`)).toBe(base);
  expect(await git(root, "show", `${head}:base-only.txt`)).toBe("base addition");
  expect(await git(root, "status", "--porcelain")).toBe("");
});

it.each([false, true])("rejects dependency inputs changed between validation and staging, deletedAfterStaging=%s", async deletedAfterStaging => {
  const { root, expectedHead } = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "repair", version: "1.0.0" }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: "repair", lockfileVersion: 3, packages: {} }));
  await writeFile(join(root, ".git", "vitehub-install.json"), JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  await assertGitHubDependenciesCurrent(root);
  const bin = await mkdtemp(join(tmpdir(), "vitehub-staging-race-")); roots.push(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "add" ]; then
    printf '%s' '{"name":"repair","version":"2.0.0"}' > package.json
  fi
done
if [ "${deletedAfterStaging ? "true" : "false"}" = "true" ]; then
  for arg in "$@"; do
    if [ "$arg" = "checkout-index" ]; then rm -f package.json; fi
  done
fi
exec /usr/bin/git "$@"
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${previousPath}`;
    const options = { expectedHead, verifyDependencies: true };
    await expect(commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["package.json", "package-lock.json"] }, options)).rejects.toThrow(/refreshDependencies/);
  } finally { process.env.PATH = previousPath; }
  expect(await git(root, "rev-parse", "HEAD")).toBe(expectedHead);
  expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
});

it("commits unchanged dependency inputs after staged validation", async () => {
  const { root, expectedHead } = await fixture();
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "repair", version: "1.0.0" }));
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ name: "repair", lockfileVersion: 3, packages: {} }));
  await writeFile(join(root, ".git", "vitehub-install.json"), JSON.stringify({ status: "installed", fingerprint: await validateGitHubInstallInputs(root) }));
  const options = { expectedHead, verifyDependencies: true };
  const head = await commitGitHubPullRequestWorkspace(root, { message: "repair", paths: ["package.json", "package-lock.json"] }, options);
  expect(JSON.parse(await git(root, "show", `${head}:package.json`)).version).toBe("1.0.0");
});

it("fetches an exact live base that advanced after checkout creation", async () => {
  const { root, expectedHead } = await fixture();
  const checkout = await mkdtemp(join(tmpdir(), "vitehub-live-base-")); roots.push(checkout);
  await git(root, "clone", "--no-local", root, checkout);
  await writeFile(join(root, "live-base.txt"), "new base\n");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "advance base");
  const base = await git(root, "rev-parse", "HEAD");
  await expect(git(checkout, "cat-file", "-e", base)).rejects.toThrow();
  await prepareGitHubRepairBase(checkout, { expectedHead, base, fetch: { url: root, env: {} } });
  expect((await readFile(join(checkout, ".git", "MERGE_HEAD"), "utf8")).trim()).toBe(base);
  expect(await readFile(join(checkout, "live-base.txt"), "utf8")).toBe("new base\n");
});
