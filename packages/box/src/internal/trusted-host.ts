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
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";

import type { HarnessV1NetworkSandboxSession, HarnessV1SandboxProvider } from "@ai-sdk/harness";

import type {
  BoxRuntime,
  ResolvedBox,
  ResolvedBoxFile,
  ResolvedBoxInput,
  ResolvedBoxRequirementInput,
  ResolvedBoxState,
} from "../index.ts";

export interface TrustedHostOptions {
  stateRoot?: string;
}

interface TrustedHostSession extends HarnessV1NetworkSandboxSession {
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
  "HOME",
  "INIT_CWD",
  "OLDPWD",
  "PWD",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);

export function trustedHost(options: TrustedHostOptions = {}): BoxRuntime {
  return {
    name: "trusted-host",
    async resolve(input) {
      const cwd = input.cwd ? resolve(input.cwd) : undefined;
      if (cwd) await assertDirectory(cwd, "workspace");
      const configuredStateRoot = options.stateRoot;
      if (input.plan.state.length && (!configuredStateRoot || !isAbsolute(configuredStateRoot))) {
        throw new Error(
          "[vitehub] trustedHost({ stateRoot }) requires an absolute path when box.home.state is declared.",
        );
      }
      const stateRoot = configuredStateRoot
        ? await canonicalFuturePath(configuredStateRoot)
        : undefined;
      if (input.plan.state.length && stateRoot && dirname(stateRoot) === stateRoot) {
        throw new Error(
          "[vitehub] Box stateRoot must be a dedicated directory, not the filesystem root.",
        );
      }
      if (cwd && input.plan.state.length && stateRoot) {
        const workspace = await realpath(cwd);
        if (pathsOverlap(workspace, stateRoot))
          throw new Error("[vitehub] Box stateRoot must be outside the authoritative workspace.");
      }
      const sandbox = createTrustedHostSandbox(input, { stateRoot });
      const environment = {} as ResolvedBox["environment"];
      Object.defineProperty(environment, "env", { enumerable: false, value: Object.freeze({}) });
      const box = {
        cache: { state: "disposable" },
        environment,
        identity: input.identity,
        isolation: "none",
        requirements: input.requirements.map(({ command, name }) => ({ command, name })),
        runtime: "trusted-host",
        sandbox,
        workspace: cwd
          ? { path: cwd, state: "authoritative" as const }
          : { state: "disposable" as const },
      } as const;
      Object.defineProperty(box, "sandbox", { enumerable: false, value: sandbox });
      return box;
    },
  };
}

function createTrustedHostSandbox(
  input: ResolvedBoxInput,
  options: TrustedHostOptions,
): HarnessV1SandboxProvider {
  return {
    providerId: "trusted-host",
    specificationVersion: "harness-sandbox-v1",
    async createSession(createOptions = {}) {
      return await createSession(input, options, createOptions);
    },
    async resumeSession(resumeOptions) {
      return await createSession(input, options, { sessionId: resumeOptions.sessionId });
    },
  };
}

async function createSession(
  input: ResolvedBoxInput,
  options: TrustedHostOptions,
  createOptions: {
    abortSignal?: AbortSignal;
    onFirstCreate?: (
      session: HarnessV1NetworkSandboxSession,
      context: { abortSignal?: AbortSignal },
    ) => Promise<void>;
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
  try {
    root = await mkdtemp(join(tmpdir(), "vitehub-box-"));
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const states = await prepareState(input.plan.state, options.stateRoot);
    const files = await resolveFiles(input.plan.files);
    const env = await resolveEnvironment(home, input.plan.env);
    await materializeState(home, states);
    await materializeFiles(home, files);
    session = await createTrustedHostSession({
      env,
      home,
      release: releases,
      root,
      sessionId: createOptions.sessionId,
      workspace: input.cwd,
    });
    await validateRequirements(input.requirements, env, input.cwd ?? root);
    await createOptions.onFirstCreate?.(session, { abortSignal: createOptions.abortSignal });
    return session;
  } catch (error) {
    if (session) await Promise.resolve(session.destroy?.()).catch(() => undefined);
    else {
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
      seed: existing ? [] : await resolveFiles(state.seed),
    });
  }
  return prepared;
}

async function materializeState(home: string, states: readonly PreparedState[]) {
  for (const state of states) {
    if (state.initialize) {
      const staging = `${state.persistent}.init-${randomUUID()}`;
      try {
        await mkdir(staging, { mode: 0o700 });
        await materializeFiles(staging, state.seed);
        await rename(staging, state.persistent);
      } finally {
        await rm(staging, { force: true, recursive: true }).catch(() => undefined);
      }
    }
    await chmod(state.persistent, 0o700);
    const target = join(home, ...state.path.split("/"));
    await mkdir(dirname(target), { mode: 0o700, recursive: true });
    await symlink(state.persistent, target, "dir");
  }
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
  if (options.workspace) await symlink(options.workspace, join(options.root, "workspace"), "dir");
  let destroyed = false;
  const processes = new Set<ChildProcessWithoutNullStreams>();
  const session = {
    defaultWorkingDirectory: options.root,
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
      const child = await this.spawn(runOptions);
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
      assertCommandEnvironment(runOptions.env);
      const cwd = await physicalSessionPath(options.root, runOptions.workingDirectory);
      const child = spawnChildProcess(runOptions.command, {
        cwd,
        detached: process.platform !== "win32",
        env: { ...options.env, ...runOptions.env, INIT_CWD: cwd, OLDPWD: cwd, PWD: cwd },
        shell: true,
      });
      processes.add(child);
      child.once("close", () => processes.delete(child));
      return processHandle(child, runOptions.abortSignal);
    },
    async stop() {
      const active = [...processes];
      for (const child of active) signalProcessTree(child, "SIGTERM");
      await Promise.race([
        Promise.all(active.map(waitForExit)),
        new Promise((resolvePromise) => setTimeout(resolvePromise, 250)),
      ]);
      for (const child of active) signalProcessTree(child, "SIGKILL");
      await Promise.all(active.map(waitForExit));
      processes.clear();
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
) {
  for (const requirement of requirements) {
    const executable = await findExecutable(requirement.command, env.PATH, env.PATHEXT);
    if (!executable)
      throw new Error(
        `[vitehub] Box requirement "${requirement.name}" is unavailable: ${requirement.command} is not on PATH.`,
      );
    if (!requirement.args.length) continue;
    try {
      await promisify(execFile)(executable, requirement.args, {
        cwd,
        env,
        shell: isWindowsCommandShim(executable),
        timeout: 10_000,
      });
    } catch {
      throw new Error(`[vitehub] Box requirement "${requirement.name}" failed.`);
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
  while (true) {
    abortSignal?.throwIfAborted();
    const acquired = await mkdir(path, { mode: 0o700 }).then(
      () => true,
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
        if (await staleLock(path)) {
          await rm(path, { force: true, recursive: true });
          return false;
        }
        return false;
      },
    );
    if (acquired) {
      try {
        await writeFile(
          join(path, "owner.json"),
          JSON.stringify({ host: hostname(), pid: process.pid }),
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
        return JSON.parse(value) as { host?: unknown; pid?: unknown };
      } catch {
        return undefined;
      }
    },
    () => undefined,
  );
  if (!owner) {
    const item = await stat(path).catch(() => undefined);
    return Boolean(item && Date.now() - item.mtimeMs > 5_000);
  }
  if (owner.host !== hostname() || typeof owner.pid !== "number") return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
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
      ? names.map((name) => resolve(name))
      : (path || "")
          .split(delimiter)
          .filter(Boolean)
          .flatMap((directory) => names.map((name) => join(directory, name)));
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
  const abort = () => {
    abortReason = abortSignal?.reason || new Error("Box command aborted.");
    signalProcessTree(child, "SIGTERM");
  };
  abortSignal?.addEventListener("abort", abort, { once: true });
  const wait = new Promise<{ exitCode: number }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      abortSignal?.removeEventListener("abort", abort);
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
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
}
