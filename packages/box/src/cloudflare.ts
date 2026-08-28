import type { BoxFileEntry, BoxRuntime } from "./index.ts";
import type { ExecutionAuthority } from "@vite-hub/runtime";
import {
  openRemoteBox,
  remoteBoxPlan,
  resolveRemoteEnvironment,
  shellQuote,
  snapshotStream,
} from "./internal/remote.ts";
import type { RuntimeProcess, RuntimeSession } from "./internal/session.ts";
import {
  cloudflareControlPlaneTimeout,
  cloudflareExecTimeout,
  cloudflareReadTimeout,
  cloudflareStopTimeout,
  withCloudflareRequest,
} from "./internal/cloudflare-transport.ts";
import { markBuiltInBoxRuntime } from "./internal/runtime.ts";

const cloudflareSandboxPackage = "@cloudflare/sandbox";

export interface CloudflareBoxOptions {
  cloudflare?: {
    keepAlive?: boolean;
    normalizeId?: boolean;
    sleepAfter?: number | string;
  };
  getSandbox?: (
    namespace: CloudflareDurableObjectNamespace,
    id: string,
    options?: CloudflareBoxOptions["cloudflare"],
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
  deleteFile?(path: string): Promise<{ success: boolean } | void>;
  destroy(): Promise<void>;
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
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
    options?: { cwd?: string; env?: Record<string, string> },
  ): Promise<{
    getLogs(): Promise<{ stderr: string; stdout: string }>;
    id: string;
    kill(signal?: string): Promise<void>;
    waitForExit(): Promise<{ exitCode: number }>;
  }>;
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

export function createCloudflareRuntime(options: CloudflareBoxOptions): BoxRuntime {
  if (!options?.namespace)
    throw new TypeError("[vitehub] The cloudflare Box runtime requires a Durable Objects namespace.");
  return markBuiltInBoxRuntime({
    name: "cloudflare",
    async prepare(input) {
      return remoteBoxPlan(input, {
        executionAuthority: cloudflareExecutionAuthority,
        runtime: "cloudflare",
      });
    },
    async open(input, openOptions) {
      const env = await resolveRemoteEnvironment(input, {});
      const id = openOptions?.id ?? options.sandboxId ?? `vitehub-${crypto.randomUUID()}`;
      const getSandbox = options.getSandbox ?? await loadCloudflareSandbox();
      const stub = getSandbox(options.namespace, id, options.cloudflare);
      const runtimeSession = createCloudflareSession(id, stub, env, options.hostname);
      return await openRemoteBox(input, runtimeSession, {
        executionAuthority: openOptions.executionAuthority,
        initialize: openOptions?.initialize,
        runtime: "cloudflare",
        signal: openOptions?.signal,
      }, env);
    },
  });
}

async function loadCloudflareSandbox() {
  try {
    const { getSandbox } = await import(/* @vite-ignore */ cloudflareSandboxPackage);
    // SAFETY: the optional package's public getSandbox export implements this adapter contract.
    return getSandbox as NonNullable<CloudflareBoxOptions["getSandbox"]>;
  } catch (error) {
    throw new Error(
      `[vitehub] The cloudflare Box runtime requires @cloudflare/sandbox: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function createCloudflareSession(
  id: string,
  stub: CloudflareSandboxStub,
  baseEnv: Record<string, string>,
  hostname: string | undefined,
): RuntimeSession {
  let destroyed = false;
  const destroy = async () => {
    if (destroyed) return;
    destroyed = true;
    await withCloudflareRequest("destroy", cloudflareStopTimeout, async () => await stub.destroy());
  };
  const request = <T>(operation: string, run: () => Promise<T>, timeout = cloudflareControlPlaneTimeout) =>
    withCloudflareRequest(operation, timeout, run);
  const run = async (options: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    timeout?: number;
    workingDirectory?: string;
  }) => {
    const timeout = options.timeout ?? cloudflareExecTimeout;
    const result = await abortable(
      request("exec", async () => await stub.exec(options.command, {
        cwd: options.workingDirectory ?? "/workspace",
        env: { ...baseEnv, ...options.env },
        timeout,
      }), timeout),
      options.abortSignal,
      destroy,
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
      if (stub.exists) return (await request("exists", async () => await stub.exists!(path))).exists;
      return (await run({ abortSignal, command: `test -e ${shellQuote(path)}` })).exitCode === 0;
    },
    ...(hostname && stub.exposePort
      ? {
          async getPortUrl({ port, protocol = "http" }: { port: number; protocol?: "http" | "https" | "ws" }) {
            const result = await request("exposePort", async () => await stub.exposePort!(port, {
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
        const result = await request("listFiles", async () => await stub.listFiles!(path, { recursive }));
        return result.files
          .filter((file): file is typeof file & { type: "directory" | "file" | "symlink" } =>
            file.type === "directory" || file.type === "file" || file.type === "symlink"
          )
          .map((file) => ({ path: file.absolutePath, size: file.size, type: file.type }))
          .sort((left, right) => left.path.localeCompare(right.path));
      }
      return await listWithFind(run, path, recursive, abortSignal);
    },
    async makeDirectory({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (stub.mkdir) {
        const result = await request("mkdir", async () => await stub.mkdir!(path, { recursive }));
        if (result && !result.success) throw new Error(`[vitehub] Cloudflare failed to create ${path}.`);
        return;
      }
      const result = await run({
        abortSignal,
        command: `mkdir ${recursive ? "-p " : ""}-- ${shellQuote(path)}`,
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    },
    ...(stub.moveFile
      ? {
          async moveFile({ abortSignal, destination, source }: { abortSignal?: AbortSignal; destination: string; source: string }) {
            abortSignal?.throwIfAborted();
            const result = await request("moveFile", async () => await stub.moveFile!(source, destination));
            if (result && !result.success) throw new Error(`[vitehub] Cloudflare failed to move ${source}.`);
          },
        }
      : {}),
    async readBinaryFile({ abortSignal, path }) {
      abortSignal?.throwIfAborted();
      const result = await request("readFile", async () => await stub.readFile(path, { encoding: "base64" }), cloudflareReadTimeout);
      if (result.success === false) {
        const exists = stub.exists ? (await request("exists", async () => await stub.exists!(path))).exists : false;
        if (!exists) return null;
        throw new Error(`[vitehub] Cloudflare failed to read ${path}.`);
      }
      return decodeBase64(result.content);
    },
    async removeFile({ abortSignal, path, recursive }) {
      abortSignal?.throwIfAborted();
      if (!recursive && stub.deleteFile) {
        const result = await request("deleteFile", async () => await stub.deleteFile!(path));
        if (result && !result.success) throw new Error(`[vitehub] Cloudflare failed to remove ${path}.`);
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
    ...(stub.startProcess
      ? {
          async spawn(commandOptions: {
            abortSignal?: AbortSignal;
            command: string;
            env?: Record<string, string>;
            workingDirectory?: string;
          }) {
            commandOptions.abortSignal?.throwIfAborted();
            const process = await request("startProcess", async () => await stub.startProcess!(commandOptions.command, {
              cwd: commandOptions.workingDirectory ?? "/workspace",
              env: { ...baseEnv, ...commandOptions.env },
            }));
            return cloudflareProcess(process);
          },
        }
      : {}),
    async stop() {},
    async writeBinaryFile({ abortSignal, content, path }) {
      abortSignal?.throwIfAborted();
      const result = await request("writeFile", async () => await stub.writeFile(path, encodeBase64(content), {
        encoding: "base64",
      }));
      if (result && !result.success) throw new Error(`[vitehub] Cloudflare failed to write ${path}.`);
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

function cloudflareProcess(process: Awaited<ReturnType<NonNullable<CloudflareSandboxStub["startProcess"]>>>): RuntimeProcess {
  const wait = process.waitForExit();
  return {
    stderr: snapshotStream(async () => (await process.getLogs()).stderr),
    stdout: snapshotStream(async () => (await process.getLogs()).stdout),
    async kill(signal?: string) {
      await process.kill(signal);
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
): Promise<BoxFileEntry[]> {
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

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  abort: () => Promise<void>,
) {
  if (!signal) return await operation;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
      void abort().catch(() => undefined);
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
