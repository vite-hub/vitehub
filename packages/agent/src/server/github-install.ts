import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { validateGitHubInstallInputs } from "./github-install-inputs.ts";
import { createGitHubInstallSnapshot, publishGitHubInstallSnapshot } from "./github-install-snapshot.ts";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import * as v from "valibot";
import { parse } from "yaml";

const exec = promisify(execFile);
const manifest = v.object({ packageManager: v.optional(v.string()) });
const systemError = v.object({ errno: v.pipe(v.number(), v.integer(), v.maxValue(-1)) });
const exists = async (path: string) => await access(path).then(() => true, () => false);
const isSystemError = (error: unknown) => v.safeParse(systemError, error).success;

export class GitHubWorkspaceInstallError extends Error {
  constructor(cause: unknown, readonly retryable = true) { super(`Frozen dependency installation failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
}

/** Trusted host hook for dependency caching; commands and inputs have already been validated. */
export interface GitHubInstallRunner {
  (input: { cwd: string; command: string[]; env: NodeJS.ProcessEnv; fingerprint: string }): Promise<Record<string, unknown> | void>;
}

let installationTail: Promise<void> = Promise.resolve();

/** Install frozen dependencies before entering the provider's network sandbox. */
export async function installGitHubPullRequestWorkspace(target: string, signal?: AbortSignal, run?: GitHubInstallRunner): Promise<void> {
  signal?.throwIfAborted();
  if (!(await exists(join(target, "package.json"))) && !(await exists(join(target, "pnpm-workspace.yaml")))) return;
  signal?.throwIfAborted();
  const previous = installationTail;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  // An aborted waiter releases its own reservation, but later work still waits
  // for every predecessor. Installers can each use multiple GiB of host memory.
  installationTail = previous.then(() => held);
  let abort!: () => void;
  let queueTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        queueTimeout = setTimeout(() => reject(new GitHubWorkspaceInstallError(new Error("Dependency installer capacity remained busy for two minutes; retry when capacity is available."))), 2 * 60_000);
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason ?? new DOMException("Installation cancelled.", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
    clearTimeout(queueTimeout);
    signal?.throwIfAborted();
    await installWorkspace(target, signal, run);
  } finally {
    clearTimeout(queueTimeout);
    signal?.removeEventListener("abort", abort);
    release();
  }
}

async function installWorkspace(target: string, signal?: AbortSignal, run?: GitHubInstallRunner): Promise<void> {
  if (!(await exists(join(target, "package.json"))) && !(await exists(join(target, "pnpm-workspace.yaml")))) return;
  signal?.throwIfAborted();
  const home = join(target, ".git", "vitehub-install-home");
  await mkdir(home, { recursive: true });
  // Corepack caches CommonJS managers below HOME. The checkout's ESM package
  // scope must not reinterpret their .js executables as ES modules.
  await writeFile(join(home, "package.json"), JSON.stringify({ type: "commonjs" }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, YARN_ENABLE_SCRIPTS: "false", YARN_IGNORE_PATH: "1", COREPACK_ENV_FILE: "0", COREPACK_NPM_REGISTRY: "https://registry.npmjs.org", COREPACK_ENABLE_PROJECT_SPEC: "0", COREPACK_DEFAULT_TO_LATEST: "0", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };
  const record = join(target, ".git", "vitehub-install.json");
  let runMetadata: Record<string, unknown> | void = undefined;
  let command: string | undefined;
  let args: string[] = [];
  let yarnConfig: string | undefined;
  let snapshot: Awaited<ReturnType<typeof createGitHubInstallSnapshot>> | undefined;
  let retryable = false;
  try {
    snapshot = await createGitHubInstallSnapshot(target);
    const source = snapshot.directory;
    const fingerprint = await validateGitHubInstallInputs(source);
    const { packageManager } = v.parse(manifest, await exists(join(source, "package.json")) ? JSON.parse(await readFile(join(source, "package.json"), "utf8")) : {});
    // Corepack must not execute a PR-supplied URL, devEngines override or yarnPath.
    // Select an official package-manager version and disable repository extensions.
    const version = (name: string, fallback: string) => {
      if (!packageManager) return fallback;
      const match = packageManager.match(/^(pnpm|npm|yarn)@(\d+\.\d+\.\d+)(?:\+sha(?:224|256|384|512)\.[a-f\d]+)?$/);
      if (!match || match[1] !== name) throw new Error("packageManager must select an official matching package-manager version.");
      return match[2]!;
    };
    if (await exists(join(source, "pnpm-lock.yaml"))) {
      command = "corepack";
      args = [`pnpm@${version("pnpm", "10.34.6")}`, "install", "--frozen-lockfile", "--ignore-scripts", "--ignore-pnpmfile", "--config.manage-package-manager-versions=false"];
    }
    else if (await exists(join(source, "package-lock.json")) || await exists(join(source, "npm-shrinkwrap.json"))) {
      const npmVersion = version("npm", "11.6.3");
      if (Number(npmVersion.split(".")[0]) < 7) throw new Error("Host installation requires npm 7 or newer; older npm can execute repository onload scripts.");
      command = "corepack";
      args = [`npm@${npmVersion}`, "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    }
    else if (await exists(join(source, "yarn.lock"))) {
      command = "corepack";
      const yarnVersion = version("yarn", "1.22.22");
      args = [`yarn@${yarnVersion}`, "install"];
      if (yarnVersion.startsWith("1.")) args.push("--frozen-lockfile", "--ignore-scripts", "--ignore-path", "--no-default-rc");
      else {
        // A fresh rc filename ignores every checkout/ancestor plugin and yarnPath.
        // skip-build also suppresses workspace scripts, unlike enableScripts alone.
        env.YARN_RC_FILENAME = `.vitehub-install-${randomUUID()}.yml`;
        yarnConfig = join(source, env.YARN_RC_FILENAME);
        const projectConfig = join(source, ".yarnrc.yml");
        const config = v.parse(v.object({
          nodeLinker: v.optional(v.picklist(["pnp", "pnpm", "node-modules"])),
          pnpEnableEsmLoader: v.optional(v.boolean()),
          pnpEnableInlining: v.optional(v.boolean()),
          pnpMode: v.optional(v.picklist(["strict", "loose"])),
          pnpFallbackMode: v.optional(v.picklist(["none", "dependencies-only", "all"])),
          nmHoistingLimits: v.optional(v.picklist(["none", "workspaces", "dependencies"])),
          nmSelfReferences: v.optional(v.boolean()),
          nmMode: v.optional(v.picklist(["classic", "hardlinks-local"])),
        }),
          await exists(projectConfig) ? parse(await readFile(projectConfig, "utf8")) ?? {} : {});
        const layout = Object.entries(config).map(([key, value]) => `${key}: ${value}\n`).join("");
        await writeFile(yarnConfig, `enableScripts: false\nignorePath: true\n${layout}`, { flag: "wx" });
        args.push("--immutable", "--mode=skip-build");
      }
    }
    else throw new Error("Frozen dependency installation requires a supported lockfile.");
    // Input validation needs changed PR evidence. Commands can fail while the
    // registry or host is temporarily unavailable and retain their retry path.
    retryable = true;
    try {
      if (run) runMetadata = await run({ cwd: source, command: [command, ...args], env, fingerprint });
      else await exec(command, args, { cwd: source, env, signal, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 });
    }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT" && command === "corepack") {
        throw new Error("Babysitter host installation requires Corepack in PATH. Install Corepack on the trusted host; Node 25 and newer do not bundle it.", { cause: error });
      }
      throw error;
    }
    retryable = false;
    const current = await validateGitHubInstallInputs(target).catch(error => {
      if (isSystemError(error)) throw error;
      return undefined;
    });
    if (current !== fingerprint) throw new Error("Dependency inputs changed during installation. Call refreshDependencies again before validation.");
    retryable = true;
    await publishGitHubInstallSnapshot(snapshot, signal);
    await writeFile(record, JSON.stringify({ ...runMetadata, status: "installed", fingerprint, command: command ? [command, ...args] : undefined, at: new Date().toISOString(), scripts: runMetadata?.scripts ?? false }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeFile(record, JSON.stringify({ status: "failed", command: command ? [command, ...args] : undefined, at: new Date().toISOString(), reason })).catch(() => undefined);
    if (signal?.aborted) throw error;
    // Filesystem errors remain recoverable even when they occur during input validation.
    throw new GitHubWorkspaceInstallError(error, retryable || isSystemError(error));
  } finally {
    try {
      try { if (yarnConfig) await rm(yarnConfig, { force: true }); }
      finally { await snapshot?.close(); }
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new GitHubWorkspaceInstallError(error);
    }
  }
}

/** Require validation to use the same dependency inputs that the host installed. */
export async function assertGitHubDependenciesCurrent(target: string, inputs = target): Promise<void> {
  if (!(await exists(join(inputs, "package.json"))) && !(await exists(join(inputs, "pnpm-workspace.yaml")))) return;
  const fingerprint = await validateGitHubInstallInputs(inputs, inputs === target ? undefined : async paths => {
    const checkout = await realpath(target);
    for (const path of paths) {
      const destination = join(inputs, path);
      // The index owns tracked commands, including staged deletion. Generated
      // untracked commands remain installation inputs without entering commits.
      const indexed = await exec("git", ["--literal-pathspecs", "-C", target, "-c", "core.fsmonitor=false", "ls-files", "--cached", "--", path], {
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (indexed.stdout.trim()) continue;
      // A staged deletion has no index entry, but must still stay deleted in
      // the protected commit snapshot instead of importing live worktree bytes.
      const tracked = await exec("git", ["--literal-pathspecs", "-C", target, "-c", "core.fsmonitor=false", "ls-tree", "--name-only", "HEAD", "--", path], {
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
      if (tracked.stdout.trim()) continue;
      const source = join(checkout, path);
      const info = await lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined; });
      if (!info) { await rm(destination, { force: true }); continue; }
      if (!info.isFile()) throw new Error("Linked dependency bin targets must be regular files.");
      const resolved = await realpath(source);
      const part = relative(checkout, resolved);
      if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error("Linked dependency bin targets must stay inside the checkout.");
      // Bind the read to the validated file. A parent swap must never make
      // pathname-based copying import a different host file into this snapshot.
      const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await file.stat();
        const assertSource = async () => {
          const current = await lstat(source);
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino
            || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
            || await realpath(source) !== resolved) throw new Error("Linked dependency bin target changed during snapshot validation.");
        };
        await assertSource();
        await mkdir(dirname(destination), { recursive: true });
        await assertSource();
        const contents = await file.readFile();
        const settled = await file.stat();
        await assertSource();
        if (settled.size !== opened.size || settled.mtimeMs !== opened.mtimeMs || settled.ctimeMs !== opened.ctimeMs || settled.mode !== opened.mode) {
          throw new Error("Linked dependency bin target changed during snapshot validation.");
        }
        // A reused input snapshot must reflect the current generated command.
        // Remove its old entry before exclusive creation, without following it.
        await rm(destination, { force: true });
        await writeFile(destination, contents, { flag: "wx", mode: opened.mode & 0o777 });
        await chmod(destination, opened.mode & 0o777);
      } finally { await file.close(); }
    }
  });
  const record = v.parse(v.object({ status: v.string(), fingerprint: v.optional(v.string()) }), JSON.parse(await readFile(join(target, ".git", "vitehub-install.json"), "utf8")));
  if (record.status !== "installed" || record.fingerprint !== fingerprint) throw new Error("Dependency inputs changed or installation failed. Call refreshDependencies and rerun validation before committing.");
}
