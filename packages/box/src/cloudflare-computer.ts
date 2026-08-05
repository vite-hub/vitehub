import type { ExecutionAuthority } from "@vite-hub/runtime";
import type { BoxFileEntry, BoxRuntime } from "./index.ts";
import { openRemoteBox, remoteBoxPlan, resolveRemoteEnvironment } from "./internal/remote.ts";
import type { RuntimeSession } from "./internal/session.ts";
import { markBuiltInBoxRuntime } from "./internal/runtime.ts";

const cloudflareComputerPackage = "@cloudflare/computer";

export interface CloudflareComputerBoxOptions {
  backend?: string;
  getWorkspace?: (handle: unknown) => Promise<CloudflareComputerWorkspace>;
  namespace: CloudflareComputerDurableObjectNamespace;
}

export interface CloudflareComputerDurableObjectNamespace {
  get(id: unknown): unknown;
  idFromName(name: string): unknown;
}

export interface CloudflareComputerWorkspace {
  readonly fs: CloudflareComputerFilesystem;
  readonly runtime: {
    exec(command: string, options?: {
      backend?: string;
      cwd?: string;
      encoding?: "utf8";
      env?: Record<string, string>;
      timeoutMs?: number;
    }): Promise<CloudflareComputerExecHandle>;
  };
  [Symbol.dispose]?(): void;
}

export interface CloudflareComputerFilesystem {
  lstat(path: string): Promise<CloudflareComputerFileStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readdir(path: string): Promise<Array<{
    isDirectory: boolean;
    isFile: boolean;
    isSymbolicLink: boolean;
    name: string;
  }>>;
  rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  writeFile(path: string, contents: Uint8Array): Promise<void>;
}

export interface CloudflareComputerFileStat {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  size: number;
}

export interface CloudflareComputerExecHandle {
  readonly id: string;
  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP"): Promise<void>;
  result(): Promise<{ exitCode: number; stderr: string; stdout: string }>;
  [Symbol.dispose]?(): void;
}

const cloudflareComputerExecutionAuthority = {
  credentials: "unknown",
  environment: "selected",
  filesystem: { access: "read-write", scope: "sandbox" },
  isolation: "unknown",
  network: "unknown",
  processes: "unknown",
} as const satisfies ExecutionAuthority;

export function createCloudflareComputerRuntime(options: CloudflareComputerBoxOptions): BoxRuntime {
  if (!options?.namespace)
    throw new TypeError("[vitehub] The cloudflare-computer Box runtime requires a Durable Objects namespace.");
  return markBuiltInBoxRuntime({
    name: "cloudflare-computer",
    async prepare(input) {
      return remoteBoxPlan(input, {
        executionAuthority: cloudflareComputerExecutionAuthority,
        runtime: "cloudflare-computer",
      });
    },
    async open(input, openOptions) {
      const id = openOptions.id ?? `vitehub-${crypto.randomUUID()}`;
      const getWorkspace = options.getWorkspace ?? await loadCloudflareComputer();
      const handle = options.namespace.get(options.namespace.idFromName(id));
      const workspace = await getWorkspace(handle);
      let env: Record<string, string>;
      try {
        env = await resolveRemoteEnvironment(input, {});
      } catch (error) {
        workspace[Symbol.dispose]?.();
        throw error;
      }
      const runtimeSession = createCloudflareComputerSession(id, workspace, env, options.backend);
      return await openRemoteBox(input, runtimeSession, {
        executionAuthority: openOptions.executionAuthority,
        initialize: openOptions.initialize,
        runtime: "cloudflare-computer",
        signal: openOptions.signal,
      });
    },
  });
}

async function loadCloudflareComputer() {
  try {
    const { getWorkspace } = await import(/* @vite-ignore */ cloudflareComputerPackage);
    return getWorkspace as unknown as NonNullable<CloudflareComputerBoxOptions["getWorkspace"]>;
  } catch (error) {
    throw new Error(
      `[vitehub] The cloudflare-computer Box runtime requires @cloudflare/computer: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function createCloudflareComputerSession(
  id: string,
  workspace: CloudflareComputerWorkspace,
  baseEnv: Record<string, string>,
  backend: string | undefined,
): RuntimeSession {
  let disposed = false;
  const activeExecutions = new Set<CloudflareComputerExecHandle>();
  const releaseExecution = (execution: CloudflareComputerExecHandle) => {
    if (!activeExecutions.delete(execution)) return;
    execution[Symbol.dispose]?.();
  };
  return {
    defaultWorkingDirectory: "/workspace",
    id,
    async destroy() {
      disposed = true;
      const results = await Promise.allSettled([...activeExecutions].map(async (execution) => {
        try {
          await execution.kill("SIGKILL");
        } finally {
          releaseExecution(execution);
        }
      }));
      workspace[Symbol.dispose]?.();
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) {
        throw new AggregateError(failures.map(result => result.reason), "[vitehub] Failed to stop Cloudflare Computer executions.");
      }
    },
    async existsFile({ abortSignal, path }) {
      abortSignal?.throwIfAborted();
      try {
        await workspace.fs.lstat(path);
        return true;
      } catch (error) {
        if (isMissingFile(error)) return false;
        throw error;
      }
    },
    async listFiles({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      return await listComputerFiles(workspace.fs, path, Boolean(recursive), abortSignal);
    },
    async makeDirectory({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      await workspace.fs.mkdir(path, { recursive });
    },
    async readBinaryFile({ abortSignal, path }) {
      abortSignal?.throwIfAborted();
      try {
        return await readStream(await workspace.fs.readFile(path), abortSignal);
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },
    async removeFile({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      await workspace.fs.rm(path, { force: true, recursive });
    },
    async run({ abortSignal, command, env, workingDirectory }) {
      const execution = await workspace.runtime.exec(command, {
        ...(backend ? { backend } : {}),
        cwd: workingDirectory ?? "/workspace",
        encoding: "utf8",
        env: { ...baseEnv, ...env },
      });
      if (disposed) {
        try {
          await execution.kill("SIGKILL");
        } finally {
          execution[Symbol.dispose]?.();
        }
        throw new Error("[vitehub] Box session is closed.");
      }
      activeExecutions.add(execution);
      try {
        const result = await abortExecution(execution, abortSignal);
        return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
      } finally {
        releaseExecution(execution);
      }
    },
    async stop() {},
    async writeBinaryFile({ abortSignal, content, path }) {
      abortSignal?.throwIfAborted();
      await workspace.fs.writeFile(path, content);
    },
  };
}

async function listComputerFiles(
  filesystem: CloudflareComputerFilesystem,
  path: string,
  recursive: boolean,
  signal: AbortSignal | undefined,
): Promise<BoxFileEntry[]> {
  const result: BoxFileEntry[] = [];
  for (const child of await filesystem.readdir(path)) {
    signal?.throwIfAborted();
    const childPath = joinPath(path, child.name);
    const stat = await filesystem.lstat(childPath);
    result.push({
      path: childPath,
      size: stat.size,
      type: stat.isDirectory ? "directory" : stat.isFile ? "file" : "symlink",
    });
    if (recursive && stat.isDirectory) {
      result.push(...await listComputerFiles(filesystem, childPath, true, signal));
    }
  }
  return result;
}

async function abortExecution(execution: CloudflareComputerExecHandle, signal: AbortSignal | undefined) {
  if (!signal) return await execution.result();
  signal.throwIfAborted();
  return await new Promise<Awaited<ReturnType<CloudflareComputerExecHandle["result"]>>>((resolve, reject) => {
    const abort = () => {
      void execution.kill("SIGKILL").catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void execution.result().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function readStream(stream: ReadableStream<Uint8Array>, signal: AbortSignal | undefined) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isMissingFile(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function joinPath(parent: string, child: string) {
  return parent === "/" ? `/${child}` : `${parent.replace(/\/$/, "")}/${child}`;
}
