import { listCommandFiles } from "./internal/file-listing.ts";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { ExecutionAuthority } from "@vite-hub/runtime";

import type { SandboxFileEntry, SandboxRuntime } from "./index.ts";
import {
  collectProcessOutput,
  openRemoteSandbox,
  remoteSandboxPlan,
  resolveRemoteEnvironment,
} from "./internal/remote.ts";
import type { RuntimeProcess, RuntimeSession } from "./internal/session.ts";
import { shellQuote } from "./internal/shell-quote.ts";
import { markBuiltInSandboxRuntime } from "./internal/runtime.ts";
import { killOnAbort } from "./internal/abortable.ts";
import { sandboxErrorDiagnostics } from "./error-diagnostics.ts"

const vercelSandboxPackage = "@vercel/sandbox";

export type VercelSandboxSource =
  | { depth?: number; revision?: string; type: "git"; url: string }
  | { password: string; username: string; depth?: number; revision?: string; type: "git"; url: string }
  | { snapshotId: string; type: "snapshot" }
  | { type: "tarball"; url: string };

export type VercelSandboxNetworkPolicy =
  | "allow-all"
  | "deny-all"
  | {
      allow?: readonly string[] | Readonly<Record<string, readonly unknown[]>>;
      subnets?: { allow?: readonly string[]; deny?: readonly string[] };
    };

export interface VercelSandboxOptions {
  cpu?: number;
  create?: (options: VercelSandboxCreateOptions) => Promise<VercelSandboxInstance>;
  networkPolicy?: VercelSandboxNetworkPolicy;
  ports?: readonly number[];
  projectId?: string;
  runtime?: "node22" | "node24" | (string & {});
  source?: VercelSandboxSource;
  teamId?: string;
  timeout?: number;
  token?: string;
}

export interface VercelSandboxCreateOptions {
  networkPolicy?: VercelSandboxNetworkPolicy;
  ports?: readonly number[];
  persistent?: boolean;
  projectId?: string;
  resources?: { vcpus?: number };
  runtime: string;
  signal?: AbortSignal;
  source?: VercelSandboxSource;
  teamId?: string;
  timeout?: number;
  token?: string;
}

/** The signals that the Vercel Sandbox SDK sends by name. Other signals use their number. */
const vercelSignalNames = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGKILL", "SIGTERM", "SIGCONT", "SIGSTOP"] as const;

export type VercelSandboxSignal = typeof vercelSignalNames[number] | number;

export interface VercelSandboxCommand {
  closeStdin(): Promise<void>;
  kill(signal?: VercelSandboxSignal): Promise<void>;
  logs(options?: { signal?: AbortSignal }): AsyncIterable<{ data: string; stream: "stderr" | "stdout" }>;
  stderr(): Promise<string>;
  stdout(): Promise<string>;
  wait(): Promise<{ exitCode: number }>;
  writeStdin(data: Uint8Array): Promise<void>;
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
    stdin?: boolean;
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

export function createVercelRuntime(options: VercelSandboxOptions = {}): SandboxRuntime {
  const runtime = options.runtime ?? "node24";
  const executionAuthority = vercelExecutionAuthority(options.networkPolicy);
  return markBuiltInSandboxRuntime({
    name: "vercel",
    async prepare(input) {
      return remoteSandboxPlan(input, { executionAuthority, runtime: "vercel" });
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
      return await openRemoteSandbox(input, runtimeSession, {
        executionAuthority: openOptions.executionAuthority,
        initialize: openOptions?.initialize,
        runtime: "vercel",
        workspace,
        preserveWorkspace: Boolean(options.source),
        signal: openOptions?.signal,
      }, env);
    },
  });
}

function vercelExecutionAuthority(
  networkPolicy: VercelSandboxNetworkPolicy | undefined,
): ExecutionAuthority {
  const network = networkPolicy === "deny-all"
    ? "none"
    : networkPolicy === undefined || networkPolicy === "allow-all"
      ? "unrestricted"
      : allowsAllNetworkDestinations(networkPolicy)
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

function allowsAllNetworkDestinations(
  networkPolicy: Exclude<VercelSandboxNetworkPolicy, string>,
): boolean {
  const subnets = ownNetworkPolicyMember(networkPolicy, "subnets");
  if (hasOwnArrayEntries(ownNetworkPolicyMember(subnets, "deny"))) return false;
  const allow = ownNetworkPolicyMember(networkPolicy, "allow");
  return Array.isArray(allow) ? hasOwnArrayValue(allow, "*") : Boolean(allow && Object.hasOwn(allow, "*"));
}

function hasEffectiveNetworkPolicy(
  networkPolicy: Exclude<VercelSandboxNetworkPolicy, string>,
): boolean {
  const allow = ownNetworkPolicyMember(networkPolicy, "allow");
  if (hasOwnArrayEntries(allow)) return true;
  if (allow && !Array.isArray(allow) && Object.keys(allow).length > 0) return true;
  const subnets = ownNetworkPolicyMember(networkPolicy, "subnets");
  return hasOwnArrayEntries(ownNetworkPolicyMember(subnets, "allow")) || hasOwnArrayEntries(ownNetworkPolicyMember(subnets, "deny"));
}

function hasOwnArrayEntries(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (Object.hasOwn(value, index)) return true;
  }
  return false;
}

function hasOwnArrayValue<T>(value: readonly T[], expected: T): boolean {
  for (let index = 0; index < value.length; index++) {
    if (Object.hasOwn(value, index) && value[index] === expected) return true;
  }
  return false;
}

function ownNetworkPolicyMember<T extends object, K extends keyof T>(
  value: T | null | undefined,
  key: K,
): T[K] | undefined {
  return value !== null && value !== undefined && Object.hasOwn(value, key) ? value[key] : undefined;
}

async function loadVercelSandbox() {
  try {
    const { Sandbox } = await import(/* @vite-ignore */ vercelSandboxPackage);
    return async (options: VercelSandboxCreateOptions) =>
      await Sandbox.create(options);
  } catch (error) {
    throw sandboxErrorDiagnostics.SANDBOX_R0142({ message: `[vitehub] The vercel Sandbox runtime requires @vercel/sandbox: ${error instanceof Error ? error.message : error}` });
  }
}

function isMissingFile(error: unknown) {
  return error !== null
    && typeof error === "object"
    && Object.hasOwn(error, "code")
    && Reflect.get(error, "code") === "ENOENT";
}

function createVercelSession(
  id: string,
  instance: VercelSandboxInstance,
  baseEnv: Record<string, string>,
  ports: readonly number[] | undefined,
  workspace: string,
): RuntimeSession {
  let destroyPromise: Promise<void> | undefined;
  const startCommand = (options: Parameters<RuntimeSession["run"]>[0]) => {
    options.abortSignal?.throwIfAborted();
    return instance.runCommand({
      args: ["-lc", options.command],
      cmd: "sh",
      cwd: options.workingDirectory ?? workspace,
      detached: true,
      env: { ...baseEnv, ...options.env },
      signal: options.abortSignal,
      ...(options.stdin ? { stdin: true } : {}),
    });
  };
  const run = async (options: Parameters<RuntimeSession["run"]>[0]) => {
    const process = await startCommand(options);
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => {
        void process.kill("SIGKILL").catch(() => undefined);
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
      destroyPromise ??= (async () => {
        if (instance.stop) await instance.stop({ blocking: true });
        else await instance[Symbol.asyncDispose]?.();
      })();
      try {
        await destroyPromise;
      } catch (error) {
        destroyPromise = undefined;
        throw error;
      }
    },
    async existsFile({ abortSignal, path }) {
      abortSignal?.throwIfAborted();
      if (fs?.exists) return await fs.exists(path, { signal: abortSignal });
      if (fs?.access) {
        try {
          await fs.access(path, { signal: abortSignal });
          return true;
        } catch (error) {
          if (isMissingFile(error)) return false;
          throw error;
        }
      }
      return (await run({ abortSignal, command: `test -e ${shellQuote(path)}` })).exitCode === 0;
    },
    ...(ports?.length
      ? {
          async getPortUrl({ port, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) {
            if (!ports.includes(port)) throw sandboxErrorDiagnostics.SANDBOX_R0143({ message: `[vitehub] Vercel Sandbox port ${port} was not declared in runtime.ports.` });
            const url = new URL(instance.domain(port));
            url.protocol = protocol === "ws"
              ? url.protocol === "https:" ? "wss:" : "ws:"
              : `${protocol}:`;
            return String(url);
          },
        }
      : undefined),
    async listFiles({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (!fs?.readdir) return await listCommandFiles(run, { abortSignal, path, recursive }, result => sandboxErrorDiagnostics.SANDBOX_R0145({ message: result.stderr }));
      const entries: SandboxFileEntry[] = [];
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
        if (isMissingFile(error)) return null;
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
      if (result.exitCode !== 0) throw sandboxErrorDiagnostics.SANDBOX_R0144({ message: result.stderr });
    },
    run,
    async spawn(options) {
      const process = await startCommand(options);
      // The SDK signal only cancels the start request of a detached command.
      return killOnAbort(vercelProcess(process, options.stdin), options.abortSignal);
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

function vercelProcess(process: VercelSandboxCommand, stdin: boolean | undefined): RuntimeProcess {
  const wait = process.wait();
  const output = streamLogs(process);
  return {
    ...output,
    ...(stdin
      ? {
          stdin: new WritableStream<Uint8Array>({
            abort: async () => await process.closeStdin(),
            close: async () => await process.closeStdin(),
            write: async chunk => await process.writeStdin(chunk),
          }),
        }
      : {}),
    async kill(signal?: string) {
      await process.kill(vercelSignal(signal));
    },
    async wait() {
      return await wait;
    },
  };
}

/** Bounds each channel independently so an unread channel cannot stall its sibling. */
function streamLogs(command: VercelSandboxCommand) {
  const bufferLimit = 1024 * 1024;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const iterator = command.logs({ signal: abort.signal })[Symbol.asyncIterator]();
  const open = new Map<"stderr" | "stdout", ReadableStreamDefaultController<Uint8Array>>();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    // Interrupt a pending SDK read before returning the async generator.
    abort.abort();
    try {
      await iterator.return?.();
    } catch {
      // The aborted log transport may reject during cleanup.
    }
  };
  const stream = (name: "stderr" | "stdout") => new ReadableStream<Uint8Array>({
    cancel() {
      open.delete(name);
      if (open.size === 0) return stop();
    },
    start(controller) {
      open.set(name, controller);
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: bufferLimit }));
  const output = { stderr: stream("stderr"), stdout: stream("stdout") };
  void (async () => {
    try {
      while (open.size > 0) {
        const entry = await iterator.next();
        if (entry.done) break;
        const line = entry.value;
        const controller = open.get(line.stream);
        if (!controller || line.data.length === 0) continue;
        // Bound the encoding allocation even when a single SDK entry is oversized.
        const chunk = new Uint8Array(Math.min(line.data.length * 3, controller.desiredSize ?? 0));
        const { read, written } = encoder.encodeInto(line.data, chunk);
        if (read < line.data.length) {
          controller.error(sandboxErrorDiagnostics.SANDBOX_R0159({ message: `Vercel ${line.stream} exceeded the ${bufferLimit}-byte output buffer limit. Consume both streams concurrently or cancel unused output.` }));
          open.delete(line.stream);
        } else {
          // Do not retain unused encoding capacity in the stream queue.
          controller.enqueue(written === chunk.byteLength ? chunk : chunk.slice(0, written));
        }
      }
      for (const controller of open.values()) controller.close();
    } catch (error) {
      for (const controller of open.values()) controller.error(error);
    } finally {
      open.clear();
      await stop();
    }
  })();
  return output;
}

function vercelSignal(signal: string | undefined): VercelSandboxSignal | undefined {
  if (signal === undefined) return undefined;
  if (/^\d+$/.test(signal)) return Number(signal);
  const name = `SIG${signal.toUpperCase().replace(/^SIG/, "")}`;
  const known = vercelSignalNames.find(value => value === name);
  if (!known)
    throw sandboxErrorDiagnostics.SANDBOX_R0165({ message: `[vitehub] Vercel Sandbox cannot send ${JSON.stringify(signal)} by name. Use ${vercelSignalNames.join(", ")}, or a signal number.` });
  return known;
}
