import { listCommandFiles } from "./internal/file-listing.ts";
import type { SandboxRuntime } from "./index.ts";
import type { ExecutionAuthority } from "@vite-hub/runtime";
import {
  openRemoteSandbox,
  remoteSandboxPlan,
  resolveRemoteEnvironment,
  snapshotStream,
} from "./internal/remote.ts";
import type { RuntimeProcess, RuntimeSession } from "./internal/session.ts";
import { shellQuote } from "./internal/shell-quote.ts";
import {
  cloudflareControlPlaneTimeout,
  cloudflareExecTimeout,
  cloudflareReadTimeout,
  cloudflareStopTimeout,
  withCloudflareRequest,
} from "./internal/cloudflare-transport.ts";
import { markBuiltInSandboxRuntime } from "./internal/runtime.ts";
import { killOnAbort } from "./internal/abortable.ts";
import { sandboxErrorDiagnostics } from "./error-diagnostics.ts"
import { cloudflareSignalNumber, type CloudflareSandboxDurableObject } from "./internal/cloudflare-durable-object.ts";

export interface CloudflareSandboxOptions {
  cloudflare?: {
    keepAlive?: boolean;
    normalizeId?: boolean;
    sleepAfter?: number | string;
  };
  getSandbox?: (
    namespace: CloudflareDurableObjectNamespace,
    id: string,
    options?: CloudflareSandboxOptions["cloudflare"],
  ) => CloudflareSandboxStub;
  hostname?: string;
  namespace: CloudflareDurableObjectNamespace;
  sandboxId?: string;
}

export interface CloudflareDurableObjectNamespace {
  get(id: unknown): unknown;
  idFromName(name: string): unknown;
}

export interface CloudflareSandboxStub {
  /** Stops the `exec` command started with this `id`, without stopping the Sandbox. */
  cancelExec(id: string): Promise<void>;
  deleteFile?(path: string): Promise<{ success: boolean } | void>;
  destroy(): Promise<void>;
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      id?: string;
      timeout?: number;
    },
  ): Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
    success: boolean;
  }>;
  exists?(path: string): Promise<{ exists: boolean }>;
  exposePort?(port: number, options: { hostname: string; protocol?: "http" | "https" }): Promise<{ url: string }>;
  listFiles?(path: string, options?: { recursive?: boolean }): Promise<{
    files: Array<{
      absolutePath: string;
      name: string;
      size: number;
      type: "directory" | "file" | "other" | "symlink";
    }>;
  }>;
  mkdir?(path: string, options?: { recursive?: boolean }): Promise<{ success: boolean } | void>;
  moveFile?(source: string, destination: string): Promise<{ success: boolean } | void>;
  readFile(path: string, options?: { encoding?: string }): Promise<{
    content: string;
    success?: boolean;
  }>;
  startProcess?(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; stdin?: boolean },
  ): Promise<{
    getLogs(): Promise<{ stderr: string; stdout: string }>;
    id: string;
    kill(signal?: string): Promise<void>;
    /** Process input, when the stub was asked for it with `stdin: true`. */
    stdin?: WritableStream<Uint8Array>;
    waitForExit(): Promise<{ exitCode: number }>;
  }>;
  /** Server-sent events with the process's buffered output, then live output until it exits. */
  streamProcessLogs?(processId: string): Promise<ReadableStream<Uint8Array>>;
  writeFile(
    path: string,
    contents: string,
    options?: { encoding?: string },
  ): Promise<{ success: boolean } | void>;
}

const cloudflareExecutionAuthority = {
  credentials: "unknown",
  environment: "selected",
  filesystem: { access: "read-write", scope: "sandbox" },
  isolation: "container",
  network: "unknown",
  processes: "arbitrary",
} as const satisfies ExecutionAuthority;

// The built-in Durable Object starts every Container with `enableInternet: true`.
const builtInCloudflareExecutionAuthority = {
  ...cloudflareExecutionAuthority,
  network: "unrestricted",
} as const satisfies ExecutionAuthority;

export function createCloudflareRuntime(options: CloudflareSandboxOptions): SandboxRuntime {
  if (!options?.namespace)
    throw sandboxErrorDiagnostics.SANDBOX_R0020({ message: "[vitehub] The cloudflare Sandbox runtime requires a Durable Objects namespace." });
  return markBuiltInSandboxRuntime({
    name: "cloudflare",
    async prepare(input) {
      return remoteSandboxPlan(input, {
        // A custom `getSandbox` decides the Container network itself.
        executionAuthority: options.getSandbox ? cloudflareExecutionAuthority : builtInCloudflareExecutionAuthority,
        runtime: "cloudflare",
      });
    },
    async open(input, openOptions) {
      const env = await resolveRemoteEnvironment(input, {});
      const id = openOptions?.id ?? options.sandboxId ?? `vitehub-${crypto.randomUUID()}`;
      const getSandbox = options.getSandbox ?? getCloudflareSandbox;
      const stub = getSandbox(options.namespace, id, options.cloudflare);
      const runtimeSession = createCloudflareSession(id, stub, env, options.hostname, !options.getSandbox);
      return await openRemoteSandbox(input, runtimeSession, {
        executionAuthority: openOptions.executionAuthority,
        initialize: openOptions?.initialize,
        runtime: "cloudflare",
        signal: openOptions?.signal,
      }, env);
    },
  });
}

/**
 * Reaches the Sandbox Durable Object that the ViteHub Cloudflare host integration exports.
 * @cloudflare/sandbox 1.0 has no `getSandbox`; the generated class implements this stub over RPC.
 */
function getCloudflareSandbox(
  namespace: CloudflareDurableObjectNamespace,
  id: string,
  options: CloudflareSandboxOptions["cloudflare"] = {},
): CloudflareSandboxStub {
  // SAFETY: the namespace binds the generated class, whose RPC methods implement CloudflareSandboxDurableObject.
  const target = namespace.get(namespace.idFromName(options.normalizeId ? id.toLowerCase() : id)) as CloudflareSandboxDurableObject;
  let configured: Promise<void> | undefined;
  const ready = async () => {
    configured ??= target.configure({ keepAlive: options.keepAlive, sleepAfter: options.sleepAfter })
      .catch((error: unknown) => {
        configured = undefined;
        throw error;
      });
    await configured;
  };
  // List each method: a Durable Object stub answers every property name, and the session
  // only falls back to shell commands for methods the stub lacks (listFiles, exposePort).
  return {
    cancelExec: async id => (await ready(), await target.cancelExec(id)),
    deleteFile: async path => (await ready(), await target.deleteFile(path)),
    destroy: async () => (await ready(), await target.destroy()),
    exec: async (command, execOptions) => (await ready(), await target.exec(command, execOptions)),
    exists: async path => (await ready(), await target.exists(path)),
    mkdir: async (path, mkdirOptions) => (await ready(), await target.mkdir(path, mkdirOptions)),
    moveFile: async (source, destination) => (await ready(), await target.moveFile(source, destination)),
    readFile: async (path, readOptions) => (await ready(), await target.readFile(path, readOptions)),
    startProcess: async (command, processOptions) => (await ready(), await target.startProcess(command, processOptions)),
    streamProcessLogs: async processId => (await ready(), await target.streamProcessLogs(processId)),
    writeFile: async (path, contents, writeOptions) => (await ready(), await target.writeFile(path, contents, writeOptions)),
  };
}

function createCloudflareSession(
  id: string,
  stub: CloudflareSandboxStub,
  baseEnv: Record<string, string>,
  hostname: string | undefined,
  builtIn: boolean,
): RuntimeSession {
  let destroyPromise: Promise<void> | undefined;
  const destroy = async () => {
    if (destroyPromise) return await destroyPromise;
    destroyPromise = withCloudflareRequest("destroy", { idempotent: true, timeout: cloudflareStopTimeout }, async () => await stub.destroy());
    try {
      await destroyPromise;
    } catch (error) {
      destroyPromise = undefined;
      throw error;
    }
  };
  const request = <T>(
    operation: string,
    { idempotent, signal, timeout = cloudflareControlPlaneTimeout }: { idempotent: boolean; signal?: AbortSignal; timeout?: number },
    run: () => Promise<T>,
  ) => withCloudflareRequest(operation, { idempotent, signal, timeout }, run);
  const run = async (options: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    timeout?: number;
    workingDirectory?: string;
  }, idempotent = false) => {
    const timeout = options.timeout ?? cloudflareExecTimeout;
    const execId = crypto.randomUUID();
    const result = await abortable(
      request("exec", { idempotent, timeout }, async () => await stub.exec(options.command, {
        cwd: options.workingDirectory ?? "/workspace",
        env: { ...baseEnv, ...options.env },
        id: execId,
        timeout,
      })),
      options.abortSignal,
      // Stop only this command. The Sandbox and its other processes keep running.
      () => request("cancelExec", { idempotent: true, timeout: cloudflareStopTimeout }, async () => await stub.cancelExec(execId)),
    );
    return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
  };
  return {
    defaultWorkingDirectory: "/workspace",
    id,
    async destroy() {
      await destroy();
    },
    async existsFile({ abortSignal, path }) {
      abortSignal?.throwIfAborted();
      if (stub.exists) return (await request("exists", { idempotent: true }, async () => await stub.exists!(path))).exists;
      return (await run({ abortSignal, command: `test -e ${shellQuote(path)}` }, true)).exitCode === 0;
    },
    ...(hostname && stub.exposePort
      ? {
          async getPortUrl({ port, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) {
            const result = await request("exposePort", { idempotent: false }, async () => await stub.exposePort!(port, {
              hostname,
              protocol: protocol === "ws" ? "http" : protocol,
            }));
            return protocol === "ws" ? result.url.replace(/^http/, "ws") : result.url;
          },
        }
      : {}),
    async listFiles({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (stub.listFiles) {
        const result = await request("listFiles", { idempotent: true }, async () => await stub.listFiles!(path, { recursive }));
        return result.files
          .filter((file): file is typeof file & { type: "directory" | "file" | "symlink" } =>
            file.type === "directory" || file.type === "file" || file.type === "symlink"
          )
          .map((file) => ({ path: file.absolutePath, size: file.size, type: file.type }))
          .sort((left, right) => left.path.localeCompare(right.path));
      }
      return await listCommandFiles(options => run(options, true), { abortSignal, path, recursive }, result => sandboxErrorDiagnostics.SANDBOX_R0029({ message: result.stderr }));
    },
    async makeDirectory({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (stub.mkdir) {
        const result = await request("mkdir", { idempotent: recursive === true }, async () => await stub.mkdir!(path, { recursive }));
        if (result && !result.success) throw sandboxErrorDiagnostics.SANDBOX_R0022({ message: `[vitehub] Cloudflare failed to create ${path}.` });
        return;
      }
      const result = await run({
        abortSignal,
        command: `mkdir ${recursive ? "-p " : ""}-- ${shellQuote(path)}`,
      });
      if (result.exitCode !== 0) throw sandboxErrorDiagnostics.SANDBOX_R0023({ message: result.stderr });
    },
    ...(stub.moveFile
      ? {
          async moveFile({ abortSignal, destination, source }: { abortSignal?: AbortSignal; destination: string; source: string }) {
            abortSignal?.throwIfAborted();
            const result = await request("moveFile", { idempotent: false }, async () => await stub.moveFile!(source, destination));
            if (result && !result.success) throw sandboxErrorDiagnostics.SANDBOX_R0024({ message: `[vitehub] Cloudflare failed to move ${source}.` });
          },
        }
      : undefined),
    async readBinaryFile({ abortSignal, path }) {
      abortSignal?.throwIfAborted();
      const result = await abortable(
        request("readFile", { idempotent: true, signal: abortSignal, timeout: cloudflareReadTimeout }, async () => await stub.readFile(path, { encoding: "base64" })),
        abortSignal,
      );
      if (result.success === false) {
        const exists = stub.exists
          ? (await abortable(
              request("exists", { idempotent: true, signal: abortSignal }, async () => await stub.exists!(path)),
              abortSignal,
            )).exists
          : false;
        if (!exists) return null;
        throw sandboxErrorDiagnostics.SANDBOX_R0025({ message: `[vitehub] Cloudflare failed to read ${path}.` });
      }
      return decodeBase64(result.content);
    },
    async removeFile({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (!recursive && stub.deleteFile) {
        const result = await request("deleteFile", { idempotent: true }, async () => await stub.deleteFile!(path));
        if (result && !result.success) throw sandboxErrorDiagnostics.SANDBOX_R0026({ message: `[vitehub] Cloudflare failed to remove ${path}.` });
        return;
      }
      const result = await run({
        abortSignal,
        command: recursive
          ? `rm -rf -- ${shellQuote(path)}`
          : `if test -d ${shellQuote(path)}; then rmdir -- ${shellQuote(path)}; else rm -f -- ${shellQuote(path)}; fi`,
      });
      if (result.exitCode !== 0) throw sandboxErrorDiagnostics.SANDBOX_R0027({ message: result.stderr });
    },
    run,
    ...(stub.startProcess
      ? {
          async spawn(commandOptions: {
            abortSignal?: AbortSignal;
            command: string;
            env?: Record<string, string>;
            stdin?: boolean;
            workingDirectory?: string;
          }) {
            commandOptions.abortSignal?.throwIfAborted();
            const process = await request("startProcess", { idempotent: false }, async () => await stub.startProcess!(commandOptions.command, {
              cwd: commandOptions.workingDirectory ?? "/workspace",
              env: { ...baseEnv, ...commandOptions.env },
              ...(commandOptions.stdin ? { stdin: true } : {}),
            }));
            const logs = stub.streamProcessLogs
              ? request("streamProcessLogs", { idempotent: true }, async () => await stub.streamProcessLogs!(process.id))
              : undefined;
            return killOnAbort(cloudflareProcess(process, logs, builtIn), commandOptions.abortSignal);
          },
        }
      : {}),
    async stop() {},
    async writeBinaryFile({ abortSignal, content, path }) {
      abortSignal?.throwIfAborted();
      const result = await request("writeFile", { idempotent: true }, async () => await stub.writeFile(path, encodeBase64(content), {
        encoding: "base64",
      }));
      if (result && !result.success) throw sandboxErrorDiagnostics.SANDBOX_R0028({ message: `[vitehub] Cloudflare failed to write ${path}.` });
    },
  };
}

function decodeBase64(value: string) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 8192) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function cloudflareProcess(
  process: Awaited<ReturnType<NonNullable<CloudflareSandboxStub["startProcess"]>>>,
  logs: Promise<ReadableStream<Uint8Array>> | undefined,
  builtIn: boolean,
): RuntimeProcess {
  const wait = process.waitForExit();
  const output = logs
    ? processLogStreams(logs)
    : exitedProcessLogs(wait.then(async () => await process.getLogs()));
  return {
    ...output,
    ...(process.stdin ? { stdin: process.stdin } : {}),
    async kill(signal?: string) {
      // Workers RPC drops error codes, so check the signal before the request. A custom stub decides itself.
      if (builtIn && cloudflareSignalNumber(signal) === undefined)
        throw sandboxErrorDiagnostics.SANDBOX_R0165({ runtime: "Cloudflare", signal: String(signal) });
      await process.kill(signal);
    },
    async wait() {
      return await wait;
    },
  };
}

function exitedProcessLogs(logs: Promise<{ stderr: string; stdout: string }>) {
  return {
    stderr: snapshotStream(async () => (await logs).stderr),
    stdout: snapshotStream(async () => (await logs).stdout),
  };
}

interface CloudflareLogEvent {
  data?: string;
  type: string;
}

/** Bounds each channel independently so an unread channel cannot stall its sibling. */
function processLogStreams(logs: Promise<ReadableStream<Uint8Array>>) {
  const bufferLimit = 1024 * 1024;
  const encoder = new TextEncoder();
  const open = new Map<"stderr" | "stdout", ReadableStreamDefaultController<Uint8Array>>();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await reader?.cancel().catch(() => undefined);
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
  const forward = (name: "stderr" | "stdout", data: string) => {
    const controller = open.get(name);
    if (!controller || data.length === 0) return;
    // Bound the encoding allocation even when a single log event is oversized.
    const chunk = new Uint8Array(Math.min(data.length * 3, controller.desiredSize ?? 0));
    const { read, written } = encoder.encodeInto(data, chunk);
    if (read < data.length) {
      controller.error(sandboxErrorDiagnostics.SANDBOX_R0159({ message: `Cloudflare ${name} exceeded the ${bufferLimit}-byte output buffer limit. Consume both streams concurrently or cancel unused output.` }));
      open.delete(name);
    } else {
      controller.enqueue(written === chunk.byteLength ? chunk : chunk.slice(0, written));
    }
  };
  void (async () => {
    try {
      reader = (await logs).getReader();
      if (stopped) return;
      const decoder = new TextDecoder();
      let buffered = "";
      while (open.size > 0) {
        const { done, value } = await reader.read();
        buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const events = buffered.split(/\r?\n\r?\n/);
        buffered = done ? "" : events.pop()!;
        for (const event of events) {
          const data = event.split(/\r?\n/)
            .filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, ""))
            .join("\n");
          if (!data) continue;
          const log = JSON.parse(data) as CloudflareLogEvent;
          if (log.type === "stdout" || log.type === "stderr") forward(log.type, log.data ?? "");
          else if (log.type === "exit") return;
          else if (log.type === "error")
            throw new Error(`[vitehub] Cloudflare process log stream failed: ${log.data ?? "unknown error"}`);
        }
        if (done) return;
      }
    } catch (error) {
      for (const controller of open.values()) controller.error(error);
      open.clear();
    } finally {
      for (const controller of open.values()) controller.close();
      open.clear();
      await stop();
    }
  })();
  return output;
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  abort?: () => Promise<void>,
) {
  if (!signal) return await operation;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
      if (abort) void abort().catch(() => undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
