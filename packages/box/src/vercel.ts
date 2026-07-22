import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionAuthority } from "@vite-hub/runtime";

import type { Box, BoxFileEntry, BoxRuntime } from "./index.ts";
import {
  collectProcessOutput,
  openRemoteBox,
  remoteBoxPlan,
  resolveRemoteBoxRuntime,
  resolveRemoteEnvironment,
  shellQuote,
  snapshotStream,
} from "./internal/remote.ts";
import type { RuntimeProcess, RuntimeSession } from "./internal/session.ts";

export type VercelBoxSource =
  | { depth?: number; revision?: string; type: "git"; url: string }
  | { password: string; username: string; depth?: number; revision?: string; type: "git"; url: string }
  | { snapshotId: string; type: "snapshot" }
  | { type: "tarball"; url: string };

export type VercelBoxNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      allow?: readonly string[] | Readonly<Record<string, readonly unknown[]>>;
      subnets?: { allow?: readonly string[]; deny?: readonly string[] };
    };

export interface VercelBoxOptions {
  cpu?: number;
  create?: (options: VercelSandboxCreateOptions) => Promise<VercelSandboxInstance>;
  networkPolicy?: VercelBoxNetworkPolicy;
  ports?: readonly number[];
  projectId?: string;
  runtime?: "node22" | "node24" | (string & {});
  source?: VercelBoxSource;
  teamId?: string;
  timeout?: number;
  token?: string;
}

export interface VercelSandboxCreateOptions {
  networkPolicy?: VercelBoxNetworkPolicy;
  ports?: readonly number[];
  persistent?: boolean;
  projectId?: string;
  resources?: { vcpus?: number };
  runtime: string;
  signal?: AbortSignal;
  source?: VercelBoxSource;
  teamId?: string;
  timeout?: number;
  token?: string;
}

export interface VercelSandboxCommand {
  kill(): Promise<void>;
  stderr(): Promise<string>;
  stdout(): Promise<string>;
  wait(): Promise<{ exitCode: number }>;
}

export interface VercelSandboxInstance {
  domain(port: number): string;
  fs?: {
    access?(path: string, options?: { signal?: AbortSignal }): Promise<void>;
    exists?(path: string, options?: { signal?: AbortSignal }): Promise<boolean>;
    lstat?(path: string, options?: { signal?: AbortSignal }): Promise<VercelFileStat>;
    mkdir(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<unknown>;
    readFile(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
    readdir(path: string, options?: { signal?: AbortSignal }): Promise<string[]>;
    rename(source: string, destination: string, options?: { signal?: AbortSignal }): Promise<void>;
    rm(path: string, options?: { force?: boolean; recursive?: boolean; signal?: AbortSignal }): Promise<void>;
    stat(path: string, options?: { signal?: AbortSignal }): Promise<VercelFileStat>;
    writeFile(path: string, contents: Uint8Array, options?: { signal?: AbortSignal }): Promise<void>;
  };
  mkDir(path: string, options?: { signal?: AbortSignal }): Promise<void>;
  readFileToBuffer(options: { path: string }, request?: { signal?: AbortSignal }): Promise<Uint8Array | null>;
  runCommand(options: {
    args?: readonly string[];
    cmd: string;
    cwd?: string;
    detached?: boolean;
    env?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<VercelSandboxCommand>;
  stop?(options?: { blocking?: boolean; signal?: AbortSignal }): Promise<unknown>;
  writeFiles(
    files: readonly { content: Uint8Array; path: string }[],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  [Symbol.asyncDispose]?(): Promise<void>;
}

export interface VercelFileStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

export function vercelBox(options: VercelBoxOptions = {}): BoxRuntime {
  const runtime = options.runtime ?? "node24";
  const executionAuthority = vercelExecutionAuthority(options.networkPolicy);
  return {
    name: "vercel",
    async prepare(input) {
      return remoteBoxPlan(input, { executionAuthority, runtime: "vercel" });
    },
    async open(input, openOptions) {
      const workspace = options.source ? "/vercel/sandbox" : "/workspace";
      const env = await resolveRemoteEnvironment(input, { workspace });
      const create = options.create ?? await loadVercelSandbox();
      const instance = await create({
        runtime,
        persistent: false,
        signal: openOptions?.signal,
        timeout: options.timeout ?? 300_000,
        ...(options.cpu ? { resources: { vcpus: options.cpu } } : {}),
        ...(options.ports ? { ports: options.ports } : {}),
        ...(options.source ? { source: options.source } : {}),
        ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
        ...(options.token ? { token: options.token } : {}),
        ...(options.teamId ? { teamId: options.teamId } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
      });
      const runtimeSession = createVercelSession(
        openOptions?.id ?? `vitehub-${randomUUID()}`,
        instance,
        env,
        options.ports,
        workspace,
      );
      return await openRemoteBox(input, runtimeSession, {
        executionAuthority: openOptions.executionAuthority,
        initialize: openOptions?.initialize,
        runtime: "vercel",
        workspace,
        preserveWorkspace: Boolean(options.source),
        signal: openOptions?.signal,
      });
    },
  };
}

function vercelExecutionAuthority(
  networkPolicy: VercelBoxNetworkPolicy | undefined,
): ExecutionAuthority {
  const network = networkPolicy === "deny-all"
    ? "none"
    : networkPolicy === undefined || networkPolicy === "allow-all"
      ? "unrestricted"
      : hasEffectiveNetworkPolicy(networkPolicy)
        ? "restricted"
        : "unknown";
  return {
    credentials: "unknown",
    environment: "selected",
    filesystem: { access: "read-write", scope: "sandbox" },
    isolation: "microvm",
    network,
    processes: "arbitrary",
  };
}

function hasEffectiveNetworkPolicy(
  networkPolicy: Exclude<VercelBoxNetworkPolicy, string>,
): boolean {
  const allow = networkPolicy.allow;
  if (Array.isArray(allow) && allow.length > 0) return true;
  if (allow && !Array.isArray(allow) && Object.keys(allow).length > 0) return true;
  return Boolean(networkPolicy.subnets?.allow?.length || networkPolicy.subnets?.deny?.length);
}

export async function resolveVercelBox(
  options: VercelBoxOptions,
  requirements: readonly string[],
): Promise<Box> {
  return await resolveRemoteBoxRuntime(vercelBox(options), requirements);
}

async function loadVercelSandbox() {
  try {
    const { Sandbox } = await import("@vercel/sandbox");
    return async (options: VercelSandboxCreateOptions) =>
      await Sandbox.create(options as Parameters<typeof Sandbox.create>[0]) as unknown as VercelSandboxInstance;
  } catch (error) {
    throw new Error(
      `[vitehub] vercelBox() requires @vercel/sandbox: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function createVercelSession(
  id: string,
  instance: VercelSandboxInstance,
  baseEnv: Record<string, string>,
  ports: readonly number[] | undefined,
  workspace: string,
): RuntimeSession {
  let destroyed = false;
  const run = async (options: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    workingDirectory?: string;
  }) => {
    options.abortSignal?.throwIfAborted();
    const process = await instance.runCommand({
      args: ["-lc", options.command],
      cmd: "sh",
      cwd: options.workingDirectory ?? workspace,
      detached: true,
      env: { ...baseEnv, ...options.env },
      signal: options.abortSignal,
    });
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => {
        void process.kill().catch(() => undefined);
        reject(options.abortSignal!.reason);
      };
      options.abortSignal?.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([collectProcessOutput(process), aborted]);
    } finally {
      if (abort) options.abortSignal?.removeEventListener("abort", abort);
    }
  };
  const fs = instance.fs;
  return {
    defaultWorkingDirectory: workspace,
    id,
    ...(ports?.length ? { ports } : {}),
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      if (instance.stop) await instance.stop({ blocking: true });
      else await instance[Symbol.asyncDispose]?.();
    },
    async existsFile({ abortSignal, path }) {
      abortSignal?.throwIfAborted();
      if (fs?.exists) return await fs.exists(path, { signal: abortSignal });
      if (fs?.access) {
        try {
          await fs.access(path, { signal: abortSignal });
          return true;
        } catch {
          return false;
        }
      }
      return (await run({ abortSignal, command: `test -e ${shellQuote(path)}` })).exitCode === 0;
    },
    ...(ports?.length
      ? {
          async getPortUrl({ port, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) {
            if (!ports.includes(port)) throw new Error(`[vitehub] Vercel Box port ${port} was not declared in vercelBox({ ports }).`);
            const url = new URL(instance.domain(port));
            url.protocol = protocol === "ws"
              ? url.protocol === "https:" ? "wss:" : "ws:"
              : `${protocol}:`;
            return String(url);
          },
        }
      : {}),
    async listFiles({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (!fs?.readdir) return await listWithFind(run, path, recursive, abortSignal);
      const entries: BoxFileEntry[] = [];
      await visit(path);
      return entries.sort((left, right) => left.path.localeCompare(right.path));

      async function visit(directory: string) {
        for (const name of await fs!.readdir(directory, { signal: abortSignal })) {
          const child = posix.join(directory, name);
          const stat = fs!.lstat
            ? await fs!.lstat(child, { signal: abortSignal })
            : await fs!.stat(child, { signal: abortSignal });
          entries.push({
            path: child,
            size: stat.isFile() ? stat.size : undefined,
            type: stat.isDirectory()
              ? "directory"
              : stat.isSymbolicLink()
                ? "symlink"
                : "file",
          });
          if (recursive && stat.isDirectory()) await visit(child);
        }
      }
    },
    async makeDirectory({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (fs?.mkdir) {
        await fs.mkdir(path, { recursive, signal: abortSignal });
        return;
      }
      if (recursive) {
        await instance.mkDir(path, { signal: abortSignal });
        return;
      }
      await instance.mkDir(path, { signal: abortSignal });
    },
    ...(fs?.rename
      ? {
          async moveFile({ abortSignal, destination, source }: { abortSignal?: AbortSignal; destination: string; source: string }) {
            await fs.rename(source, destination, { signal: abortSignal });
          },
        }
      : {}),
    async readBinaryFile({ abortSignal, path }) {
      abortSignal?.throwIfAborted();
      try {
        const contents = fs?.readFile
          ? await fs.readFile(path, { signal: abortSignal })
          : await instance.readFileToBuffer({ path }, { signal: abortSignal });
        return contents === null ? null : new Uint8Array(contents);
      } catch (error) {
        if (!(await this.existsFile({ abortSignal, path }))) return null;
        throw error;
      }
    },
    async removeFile({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (fs?.rm) {
        await fs.rm(path, { force: true, recursive, signal: abortSignal });
        return;
      }
      const result = await run({
        abortSignal,
        command: recursive
          ? `rm -rf -- ${shellQuote(path)}`
          : `if test -d ${shellQuote(path)}; then rmdir -- ${shellQuote(path)}; else rm -f -- ${shellQuote(path)}; fi`,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    },
    run,
    async spawn(options) {
      options.abortSignal?.throwIfAborted();
      const process = await instance.runCommand({
        args: ["-lc", options.command],
        cmd: "sh",
        cwd: options.workingDirectory ?? workspace,
        detached: true,
        env: { ...baseEnv, ...options.env },
        signal: options.abortSignal,
      });
      return vercelProcess(process);
    },
    async stop() {},
    async writeBinaryFile({ abortSignal, content, path }) {
      abortSignal?.throwIfAborted();
      if (fs?.writeFile) {
        await fs.writeFile(path, content, { signal: abortSignal });
        return;
      }
      await instance.writeFiles([{ content, path }], { signal: abortSignal });
    },
  };
}

function vercelProcess(process: VercelSandboxCommand): RuntimeProcess {
  const wait = process.wait();
  return {
    stderr: snapshotStream(async () => await process.stderr()),
    stdout: snapshotStream(async () => await process.stdout()),
    async kill() {
      await process.kill();
    },
    async wait() {
      return await wait;
    },
  };
}

async function listWithFind(
  run: (options: { abortSignal?: AbortSignal; command: string }) => Promise<{ exitCode: number; stderr: string; stdout: string }>,
  path: string,
  recursive: boolean | undefined,
  abortSignal: AbortSignal | undefined,
) {
  const result = await run({
    abortSignal,
    command: `find ${shellQuote(path)} -mindepth 1 ${recursive ? "" : "-maxdepth 1 "}-printf '%y\\t%s\\t%p\\0'`,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [kind, size, filePath] = line.split("\t");
      return {
        path: filePath,
        size: kind === "f" ? Number(size) : undefined,
        type: kind === "d" ? "directory" as const : kind === "l" ? "symlink" as const : "file" as const,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}
