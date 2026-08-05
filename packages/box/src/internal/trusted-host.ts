import {
  execFile,
  spawn as spawnChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { ExecutionAuthority } from "@vite-hub/runtime";

import type {
  BoxFileEntry,
  BoxPlan,
  BoxRuntime,
  ResolvedBoxFile,
  BoxRuntimeInput,
  ResolvedBoxRequirementInput,
  ResolvedBoxState,
} from "../index.ts";
import { materializeGitCheckout } from "./git-checkout.ts";
import {
  boxRequirementError,
  boxRequirementPlan,
  boxRequirementSecrets,
  boxRequirementSignal,
  collectBoxRequirementOutput,
} from "./requirements.ts";
import { markBuiltInBoxRuntime } from "./runtime.ts";
import { createBoxSession, type RuntimeSession } from "./session.ts";

export interface TrustedHostOptions {
  stateRoot?: string;
}

interface TrustedHostSession extends RuntimeSession {
  readonly env: Record<string, string>;
  readonly home: string;
  readonly processes: Set<ChildProcessWithoutNullStreams>;
  readonly root: string;
}

interface MaterializedFile {
  contents: Uint8Array;
  path: string;
}

interface PreparedState {
  initialize: boolean;
  path: string;
  persistent: string;
  projections: readonly string[];
  seed: readonly MaterializedFile[];
}

const baseEnvironmentKeys = [
  "ComSpec",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "Path",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
] as const;

const runtimeEnvironmentKeys = new Set([
  "CODEX_HOME",
  "HOME",
  "INIT_CWD",
  "OLDPWD",
  "PWD",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);

const trustedHostExecutionAuthority = {
  credentials: "unknown",
  environment: "selected",
  filesystem: { access: "read-write", scope: "host" },
  isolation: "none",
  network: "unrestricted",
  processes: "arbitrary",
} as const satisfies ExecutionAuthority;

export function createTrustedHostRuntime(options: TrustedHostOptions = {}): BoxRuntime {
  return markBuiltInBoxRuntime({
    name: "trusted-host",
    async prepare(input) {
      const { cwd } = await resolveTrustedHostInput(input, options);
      return {
        cache: { state: "disposable" },
        environment: { env: {} },
        executionAuthority: trustedHostExecutionAuthority,
        identity: input.identity,
        requirements: boxRequirementPlan(input.requirements),
        runtime: "trusted-host",
        workspace: cwd
          ? { path: cwd, state: "authoritative" as const, workDir: "workspace" as const }
          : input.checkout
            ? { state: "disposable" as const, workDir: "." as const }
            : { state: "disposable" as const, workDir: "." as const },
      } satisfies BoxPlan;
    },
    async open(input, openOptions) {
      const resolved = await resolveTrustedHostInput(input, options);
      let initializedSession: ReturnType<typeof createBoxSession> | undefined;
      const runtimeSession = await createSession(
        { ...input, ...(resolved.cwd ? { cwd: resolved.cwd } : {}) },
        { stateRoot: resolved.stateRoot },
        {
          abortSignal: openOptions?.signal,
          ...(openOptions?.initialize
            ? {
                async initialize(session) {
                  initializedSession = createBoxSession(
                    session,
                    openOptions,
                    resolved.cwd ? join(session.defaultWorkingDirectory, "workspace") : undefined,
                  );
                  await openOptions.initialize!(initializedSession, { signal: openOptions.signal });
                },
              }
            : {}),
          sessionId: openOptions?.id,
        },
      );
      return initializedSession ?? createBoxSession(
        runtimeSession,
        openOptions,
        resolved.cwd ? join(runtimeSession.defaultWorkingDirectory, "workspace") : undefined,
      );
    },
  });
}

async function resolveTrustedHostInput(input: BoxRuntimeInput, options: TrustedHostOptions) {
  const cwd = input.cwd ? resolve(input.cwd) : undefined;
  if (cwd) await assertDirectory(cwd, "workspace");
  const configuredStateRoot = options.stateRoot;
  if (input.plan.state.length && (!configuredStateRoot || !isAbsolute(configuredStateRoot))) {
    throw new Error(
      "[vitehub] The trusted-host runtime requires stateRoot to be an absolute path when box.home.state is declared.",
    );
  }
  const stateRoot = configuredStateRoot
    ? await canonicalFuturePath(configuredStateRoot)
    : undefined;
  if (input.plan.state.length && stateRoot && dirname(stateRoot) === stateRoot) {
    throw new Error("[vitehub] Box stateRoot must be a dedicated directory, not the filesystem root.");
  }
  if (cwd && input.plan.state.length && stateRoot) {
    const workspace = await realpath(cwd);
    if (pathsOverlap(workspace, stateRoot))
      throw new Error("[vitehub] Box stateRoot must be outside the authoritative workspace.");
  }
  return { cwd, stateRoot };
}

async function createSession(
  input: BoxRuntimeInput,
  options: TrustedHostOptions,
  createOptions: {
    abortSignal?: AbortSignal;
    initialize?: (session: RuntimeSession) => Promise<void>;
    sessionId?: string;
  },
): Promise<TrustedHostSession> {
  const releases = await acquireStateLeases(
    input.plan.state,
    options.stateRoot,
    createOptions.abortSignal,
  );
  let root: string | undefined;
  let session: TrustedHostSession | undefined;
  const initializedState: string[] = [];
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "vitehub-box-")));
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const states = await prepareState(input.plan.state, options.stateRoot);
    const files = await resolveFiles(input.plan.files);
    const env = await resolveEnvironment(home, input.plan.env);
    await materializeState(home, states, initializedState);
    await materializeFiles(home, files);
    const checkout = input.checkout ? join(root, "workspace") : undefined;
    if (input.checkout && checkout) {
      await materializeGitCheckout(input.checkout, checkout, {
        abortSignal: createOptions.abortSignal,
        async run(args) {
          const result = await promisify(execFile)("git", [...args], {
            env,
            signal: createOptions.abortSignal,
          });
          return { stdout: result.stdout };
        },
      });
    }
    session = await createTrustedHostSession({
      env,
      home,
      release: releases,
      root,
      sessionId: createOptions.sessionId,
      workspace: input.cwd,
    });
    await validateRequirements(
      input.requirements,
      env,
      checkout ?? input.cwd ?? root,
      createOptions.abortSignal,
      boxRequirementSecrets([
        ...Object.keys(input.plan.env).map(name => env[name]),
        ...files.map(file => file.contents),
        ...states.flatMap(state => state.seed.map(file => file.contents)),
      ]),
      input.plan.state.length === 0,
    );
    await createOptions.initialize?.(session);
    return session;
  } catch (error) {
    if (session) {
      await Promise.resolve(session.stop()).catch(() => undefined);
      await Promise.all(
        initializedState.map((path) =>
          rm(path, { force: true, recursive: true }).catch(() => undefined)
        ),
      );
      await Promise.resolve(session.destroy?.()).catch(() => undefined);
    }
    else {
      await Promise.all(
        initializedState.map((path) =>
          rm(path, { force: true, recursive: true }).catch(() => undefined)
        ),
      );
      if (root) await rm(root, { force: true, recursive: true }).catch(() => undefined);
      await releases();
    }
    throw error;
  }
}

async function prepareState(
  states: readonly ResolvedBoxState[],
  stateRoot: string | undefined,
): Promise<PreparedState[]> {
  if (!states.length) return [];
  const prepared: PreparedState[] = [];
  for (const state of states) {
    const persistent = statePath(stateRoot!, state.key);
    const existing = await stat(persistent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing && !existing.isDirectory())
      throw new Error(`[vitehub] Box state is not a directory: ${state.key}`);
    prepared.push({
      initialize: !existing,
      path: state.path,
      persistent,
      projections: state.projections,
      seed: existing ? [] : await resolveFiles(state.seed),
    });
  }
  return prepared;
}

async function materializeState(
  home: string,
  states: readonly PreparedState[],
  initialized: string[],
) {
  for (const state of states) {
    if (state.initialize) {
      const staging = `${state.persistent}.init-${randomUUID()}`;
      try {
        await mkdir(staging, { mode: 0o700 });
        await materializeFiles(staging, state.seed);
        await rename(staging, state.persistent);
        initialized.push(state.persistent);
      } finally {
        await rm(staging, { force: true, recursive: true }).catch(() => undefined);
      }
    }
    await reconcileProjections(state);
    await chmod(state.persistent, 0o700);
    const target = join(home, ...state.path.split("/"));
    await mkdir(dirname(target), { mode: 0o700, recursive: true });
    await symlink(state.persistent, target, "dir");
  }
}

async function reconcileProjections(state: PreparedState) {
  const manifest = `${state.persistent}.projections`;
  const previous = await readFile(manifest, "utf8").then(
    (value) => {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string")) {
        throw new Error(`[vitehub] Box projection manifest is invalid: ${state.path}`);
      }
      return parsed as string[];
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const persistent = await realpath(state.persistent);
  for (const path of state.projections) {
    const parent = await canonicalFuturePath(dirname(join(state.persistent, ...path.split("/"))));
    const relativeParent = relative(persistent, parent);
    if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
      throw new Error(`[vitehub] Box projected path escapes writable state: ${state.path}/${path}`);
    }
  }
  const current = new Set(state.projections);
  for (const path of previous) {
    if (current.has(path)) continue;
    const target = join(state.persistent, ...path.split("/"));
    const parent = await realpath(dirname(target)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!parent) continue;
    const relativeParent = relative(persistent, parent);
    if (relativeParent === ".." || relativeParent.startsWith(`..${sep}`) || isAbsolute(relativeParent)) {
      throw new Error(`[vitehub] Box projected path escapes writable state: ${state.path}/${path}`);
    }
    await rm(target, { force: true, recursive: true });
  }
  await writePrivateFile(manifest, new TextEncoder().encode(JSON.stringify(state.projections)));
}

async function resolveFiles(
  files: Readonly<Record<string, ResolvedBoxFile>>,
): Promise<MaterializedFile[]> {
  return await Promise.all(
    Object.entries(files).map(async ([path, input]) => ({ contents: await input.resolve(), path })),
  );
}

async function materializeFiles(root: string, files: readonly MaterializedFile[]) {
  for (const file of files) {
    await writePrivateFile(join(root, ...file.path.split("/")), file.contents);
  }
}

async function writePrivateFile(path: string, contents: Uint8Array) {
  const directory = dirname(path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const temporary = join(directory, `.vitehub-${randomUUID()}`);
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rm(path, { force: true, recursive: true });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function resolveEnvironment(
  home: string,
  values: Readonly<Record<string, () => Promise<string>>>,
) {
  const env = Object.fromEntries(
    baseEnvironmentKeys
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  Object.assign(env, {
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  });
  for (const [name, resolveValue] of Object.entries(values)) env[name] = await resolveValue();
  return env;
}

async function createTrustedHostSession(options: {
  env: Record<string, string>;
  home: string;
  release: () => Promise<void>;
  root: string;
  sessionId?: string;
  workspace?: string;
}): Promise<TrustedHostSession> {
  const workspace = join(options.root, "workspace");
  if (options.workspace) await symlink(options.workspace, workspace, "dir");
  else await mkdir(workspace, { recursive: true });
  let destroyed = false;
  const processes = new Set<ChildProcessWithoutNullStreams>();
  const processGroups = new Set<number>();
  const session = {
    defaultWorkingDirectory: options.workspace ? options.root : workspace,
    description: "Trusted host Box.",
    env: options.env,
    home: options.home,
    id: options.sessionId || randomUUID(),
    ports: [0],
    processes,
    root: options.root,
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        await this.stop();
        await rm(options.root, { force: true, recursive: true });
      } finally {
        await options.release();
      }
    },
    async getPortUrl({
      port,
      protocol = "http",
    }: {
      port: number;
      protocol?: "http" | "https" | "ws";
    }) {
      return `${protocol}://127.0.0.1:${port}`;
    },
    async existsFile({ path }: { path: string }) {
      return await lstat(resolveSessionPath(options.root, path)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    },
    async listFiles({
      path,
      recursive = false,
    }: {
      path: string;
      recursive?: boolean;
    }) {
      const root = resolveSessionPath(options.root, path);
      const entries: BoxFileEntry[] = [];
      await visit(root, path);
      return entries.sort((left, right) => left.path.localeCompare(right.path));

      async function visit(directory: string, logicalDirectory: string) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const physicalPath = join(directory, entry.name);
          const logicalPath = posix.join(logicalDirectory, entry.name);
          const item = await lstat(physicalPath);
          entries.push({
            path: logicalPath,
            size: entry.isFile() ? item.size : undefined,
            type: entry.isDirectory()
              ? "directory" as const
              : entry.isSymbolicLink()
                ? "symlink" as const
                : "file" as const,
          });
          if (recursive && entry.isDirectory()) await visit(physicalPath, logicalPath);
        }
      }
    },
    async makeDirectory({ path, recursive = false }: { path: string; recursive?: boolean }) {
      await mkdir(resolveSessionPath(options.root, path), { recursive });
    },
    async moveFile({ destination, source }: { destination: string; source: string }) {
      const target = resolveSessionPath(options.root, destination);
      await mkdir(dirname(target), { recursive: true });
      await rename(resolveSessionPath(options.root, source), target);
    },
    async readBinaryFile({ path }: { path: string }) {
      return await readFile(resolveSessionPath(options.root, path)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
    },
    async readFile({ path }: { path: string }) {
      const bytes = await this.readBinaryFile({ path });
      return bytes ? readableStream(bytes) : null;
    },
    async readTextFile({
      encoding = "utf8",
      endLine,
      path,
      startLine,
    }: {
      encoding?: string;
      endLine?: number;
      path: string;
      startLine?: number;
    }) {
      const bytes = await this.readBinaryFile({ path });
      if (!bytes) return null;
      const text = Buffer.from(bytes).toString(encoding as BufferEncoding);
      if (startLine === undefined && endLine === undefined) return text;
      return text
        .split(/\r?\n/)
        .slice((startLine || 1) - 1, endLine)
        .join("\n");
    },
    restricted() {
      return this;
    },
    async run(runOptions: {
      abortSignal?: AbortSignal;
      command: string;
      env?: Record<string, string>;
      workingDirectory?: string;
    }) {
      const child = await (this.spawn as NonNullable<RuntimeSession["spawn"]>)(runOptions);
      const [stdout, stderr, { exitCode }] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        child.wait(),
      ]);
      return { exitCode, stderr, stdout };
    },
    async spawn(runOptions: {
      abortSignal?: AbortSignal;
      command: string;
      env?: Record<string, string>;
      workingDirectory?: string;
    }) {
      runOptions.abortSignal?.throwIfAborted();
      assertCommandEnvironment(runOptions.env);
      const cwd = await physicalSessionPath(
        options.root,
        runOptions.workingDirectory ?? this.defaultWorkingDirectory,
      );
      const child = spawnChildProcess(runOptions.command, {
        cwd,
        detached: process.platform !== "win32",
        env: { ...options.env, ...runOptions.env, INIT_CWD: cwd, OLDPWD: cwd, PWD: cwd },
        shell: true,
      });
      processes.add(child);
      if (child.pid && process.platform !== "win32") processGroups.add(child.pid);
      child.once("close", () => {
        processes.delete(child);
        if (child.pid && process.platform !== "win32" && !processGroupExists(child.pid))
          processGroups.delete(child.pid);
      });
      return processHandle(child, runOptions.abortSignal);
    },
    async stop() {
      const active = [...processes];
      for (const pid of processGroups) signalProcessGroup(pid, "SIGTERM");
      if (process.platform === "win32")
        for (const child of active) signalProcessTree(child, "SIGTERM");
      await Promise.race([
        Promise.all(active.map(waitForExit)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 250)),
      ]);
      for (const pid of processGroups) signalProcessGroup(pid, "SIGKILL");
      if (process.platform === "win32")
        for (const child of active) signalProcessTree(child, "SIGKILL");
      await Promise.all(active.map(waitForExit));
      processes.clear();
      processGroups.clear();
    },
    async removeFile({ path, recursive = false }: { path: string; recursive?: boolean }) {
      const target = resolveSessionPath(options.root, path);
      if (recursive) {
        await rm(target, { force: true, recursive: true });
        return;
      }
      const item = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!item) return;
      if (item.isDirectory() && !item.isSymbolicLink()) await rmdir(target);
      else await rm(target, { force: true });
    },
    async writeBinaryFile({ content, path }: { content: Uint8Array; path: string }) {
      const target = resolveSessionPath(options.root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async writeFile({ content, path }: { content: ReadableStream<Uint8Array>; path: string }) {
      await this.writeBinaryFile({ content: await bytesFromStream(content), path });
    },
    async writeTextFile({
      content,
      encoding = "utf8",
      path,
    }: {
      content: string;
      encoding?: string;
      path: string;
    }) {
      await this.writeBinaryFile({
        content: Buffer.from(content, encoding as BufferEncoding),
        path,
      });
    },
  } satisfies TrustedHostSession;
  return session;
}

function assertCommandEnvironment(env: Record<string, string> | undefined) {
  const name = Object.keys(env || {}).find((name) => runtimeEnvironmentKeys.has(name));
  if (name) throw new Error(`[vitehub] Box commands cannot override ${name}.`);
}

async function validateRequirements(
  requirements: readonly ResolvedBoxRequirementInput[],
  env: Record<string, string>,
  cwd: string | undefined,
  abortSignal: AbortSignal | undefined,
  secrets: readonly string[],
  includeDiagnosticOutput: boolean,
) {
  for (const requirement of requirements) {
    const executable = await findExecutable(
      requirement.command,
      env.PATH || env.Path,
      env.PATHEXT,
      cwd,
    );
    if (!executable)
      throw boxRequirementError(
        requirement,
        { message: `${requirement.command} is not on PATH.` },
        secrets,
        requirement.timeout,
        includeDiagnosticOutput,
      );
    if (!requirement.args.length) continue;
    const timeout = requirement.timeout ?? 10_000;
    let result: { exitCode: number; stderr: string; stdout: string };
    try {
      const child = spawnChildProcess(executable, requirement.args, {
        cwd,
        detached: process.platform !== "win32",
        env,
        shell: isWindowsCommandShim(executable),
      });
      const handle = processHandle(
        child,
        boxRequirementSignal({ ...requirement, timeout }, abortSignal),
      );
      const [stderr, stdout, { exitCode }] = await Promise.all([
        collectBoxRequirementOutput(handle.stderr, secrets),
        collectBoxRequirementOutput(handle.stdout, secrets),
        handle.wait(),
      ]);
      result = { exitCode, stderr, stdout };
    } catch (cause) {
      if (abortSignal?.aborted) throw abortSignal.reason;
      throw boxRequirementError(
        requirement,
        cause,
        secrets,
        timeout,
        includeDiagnosticOutput,
      );
    }
    if (result.exitCode !== 0) {
      throw boxRequirementError(
        requirement,
        result,
        secrets,
        timeout,
        includeDiagnosticOutput,
      );
    }
  }
}

async function acquireStateLeases(
  states: readonly ResolvedBoxState[],
  stateRoot: string | undefined,
  abortSignal?: AbortSignal,
) {
  if (!states.length) return async () => {};
  await ensureStateRoot(stateRoot!);
  const paths = [...new Set(states.map((state) => statePath(stateRoot!, state.key)))].sort();
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const path of paths) releases.push(await acquireFileLock(`${path}.lock`, abortSignal));
  } catch (error) {
    for (const release of releases.reverse()) await release();
    throw error;
  }
  return async () => {
    for (const release of releases.reverse()) await release();
  };
}

async function acquireFileLock(
  path: string,
  abortSignal?: AbortSignal,
): Promise<() => Promise<void>> {
  const token = randomUUID();
  while (true) {
    abortSignal?.throwIfAborted();
    const acquired = await mkdir(path, { mode: 0o700 }).then(
      () => true,
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        const staleToken = await staleLock(path);
        if (staleToken) {
          const tombstone = `${path}.stale-${staleToken}`;
          await rename(path, tombstone).then(
            () => true,
            () => false,
          );
          // Keep the non-empty tombstone so another stale waiter cannot rename a
          // freshly acquired lock using the same observed owner token.
          return false;
        }
        return false;
      },
    );
    if (acquired) {
      try {
        await writeFile(
          join(path, "owner.json"),
          JSON.stringify({ host: hostname(), pid: process.pid, token }),
          { mode: 0o600 },
        );
      } catch (error) {
        await rm(path, { force: true, recursive: true }).catch(() => undefined);
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(path, { force: true, recursive: true });
      };
    }
    await abortable(new Promise((resolvePromise) => setTimeout(resolvePromise, 25)), abortSignal);
  }
}

async function staleLock(path: string) {
  const owner = await readFile(join(path, "owner.json"), "utf8").then(
    (value) => {
      try {
        return JSON.parse(value) as { host?: unknown; pid?: unknown; token?: unknown };
      } catch {
        return undefined;
      }
    },
    () => undefined,
  );
  if (!owner) {
    const item = await stat(path).catch(() => undefined);
    return item && Date.now() - item.mtimeMs > 5_000
      ? `invalid-${item.dev}-${item.ino}-${Math.floor(item.mtimeMs)}`
      : undefined;
  }
  if (
    owner.host !== hostname() ||
    typeof owner.pid !== "number" ||
    typeof owner.token !== "string"
  )
    return undefined;
  try {
    process.kill(owner.pid, 0);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? owner.token : undefined;
  }
}

function statePath(root: string, key: string) {
  return join(resolve(root), createHash("sha256").update(key).digest("hex"));
}

function abortable<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  if (!abortSignal) return promise;
  abortSignal.throwIfAborted();
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => {
      abortSignal.removeEventListener("abort", abort);
      reject(abortSignal.reason);
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        abortSignal.removeEventListener("abort", abort);
        resolvePromise(value);
      },
      (error) => {
        abortSignal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function assertDirectory(path: string, label: string) {
  const item = await stat(path).catch(() => undefined);
  if (!item?.isDirectory())
    throw new Error(`[vitehub] Box ${label} directory does not exist: ${path}`);
}

async function canonicalFuturePath(path: string) {
  const missing: string[] = [];
  let candidate = resolve(path);
  while (true) {
    try {
      return join(await realpath(candidate), ...missing.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function ensureStateRoot(path: string) {
  await mkdir(path, { mode: 0o700, recursive: true });
  const canonical = await realpath(path);
  if (resolve(canonical) !== resolve(path))
    throw new Error("[vitehub] Box stateRoot changed while the Box was materializing.");
  await assertDirectory(canonical, "stateRoot");
}

async function findExecutable(
  command: string,
  path: string | undefined,
  pathExt: string | undefined,
  cwd: string | undefined,
) {
  const names = [
    command,
    ...(pathExt || "")
      .split(";")
      .map((extension) => extension.trim())
      .filter(Boolean)
      .flatMap((extension) => {
        return command.toLowerCase().endsWith(extension.toLowerCase())
          ? []
          : [`${command}${extension}`];
      }),
  ];
  const candidates =
    command.includes("/") || command.includes("\\") || isAbsolute(command)
      ? names.map((name) => resolve(cwd ?? process.cwd(), name))
      : (path || "")
          .split(delimiter)
          .filter(Boolean)
          .flatMap((directory) =>
            names.map((name) =>
              isAbsolute(directory) ? join(directory, name) : resolve(cwd ?? process.cwd(), directory, name),
            ),
          );
  for (const candidate of candidates) {
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
}

function isWindowsCommandShim(path: string) {
  return process.platform === "win32" && /\.(?:bat|cmd)$/i.test(path);
}

function resolveSessionPath(root: string, path = "") {
  const candidate = isRootedPath(path)
    ? isAbsolute(path) && isInside(root, resolve(path))
      ? resolve(path)
      : resolve(root, rootRelativeFragment(path))
    : resolve(root, path);
  if (!isInside(root, candidate))
    throw new Error(`[vitehub] Trusted host Box path escapes the session root: ${path}`);
  return candidate;
}

async function physicalSessionPath(root: string, path = "") {
  return await realpath(resolveSessionPath(root, path));
}

function isInside(root: string, path: string) {
  const next = relative(resolve(root), resolve(path));
  return !next || (!next.startsWith("..") && !isAbsolute(next));
}

function pathsOverlap(first: string, second: string) {
  return isInside(first, second) || isInside(second, first);
}

function isRootedPath(path: string) {
  return isAbsolute(path) || /^[A-Za-z]:/.test(path) || /^[\\/]{2}/.test(path);
}

function rootRelativeFragment(path: string) {
  return path
    .replace(/^[A-Za-z]:[\\/]*/, "")
    .replace(/^[\\/]+/, "")
    .replace(/\\/g, "/");
}

function readableStream(bytes: Uint8Array) {
  return new Response(bytes).body!;
}

async function bytesFromStream(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return await new Response(stream).text();
}

function processHandle(
  child: ChildProcessWithoutNullStreams,
  abortSignal: AbortSignal | undefined,
) {
  let abortReason: unknown;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    abortReason = abortSignal?.reason || new Error("Box command aborted.");
    signalProcessTree(child, "SIGTERM");
    forceKillTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), 250);
    forceKillTimer.unref?.();
  };
  abortSignal?.addEventListener("abort", abort, { once: true });
  const wait = new Promise<{ exitCode: number }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      abortSignal?.removeEventListener("abort", abort);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (abortReason) reject(abortReason);
      else resolvePromise({ exitCode: code ?? 1 });
    });
  });
  return {
    pid: child.pid,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    wait: () => wait,
    async kill() {
      signalProcessTree(child, "SIGTERM");
      await wait.catch(() => undefined);
    },
  };
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (child.pid && process.platform !== "win32") {
    signalProcessGroup(child.pid, signal);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processGroupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
}
