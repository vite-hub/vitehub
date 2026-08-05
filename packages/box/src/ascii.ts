import type { ExecutionAuthority } from "@vite-hub/runtime";
import type { BoxRuntime } from "./index.ts";
import {
  createAsciiSshIdentity,
  openAsciiSshSession,
  parseAsciiSshHostKeys,
  type AsciiSshIdentity,
  type AsciiSshOptions,
} from "./internal/ascii-ssh.ts";
import { openRemoteBox, remoteBoxPlan, resolveRemoteEnvironment } from "./internal/remote.ts";
import { markBuiltInBoxRuntime } from "./internal/runtime.ts";
import type { RuntimeSession } from "./internal/session.ts";

const asciiSdkPackage = "@asciidev/box-sdk";
const defaultAsciiBaseUrl = "https://ascii.dev/api/box/v1";
const defaultAsciiTtlSeconds = 7200;

export interface AsciiBoxOptions {
  apiKey?: string;
  baseUrl?: string;
  ttlSeconds?: number;
}

interface AsciiRuntimeDependencies {
  createClient?: (options: { apiKey: string; baseUrl: string }) => Promise<AsciiClient>;
  createIdentity?: () => Promise<AsciiSshIdentity>;
  openSsh?: (options: AsciiSshOptions) => Promise<RuntimeSession>;
  provisioningTimeoutMs?: number;
}

interface AsciiClient {
  command(
    input: {
      boxId: string;
      commandRequest: { command: string; timeoutSeconds?: number };
    },
    init?: RequestInit,
  ): Promise<{
    exitCode: number | null;
    stderr: string;
    stderrTruncated?: boolean;
    stdout: string;
    stdoutTruncated?: boolean;
    timedOut: boolean;
  }>;
  create(
    input: {
      createBoxRequest: {
        noEnv: true;
        ttlSeconds: number;
      };
    },
    init?: RequestInit,
  ): Promise<{ box: AsciiBoxInfo }>;
  get(input: { boxId: string }, init?: RequestInit): Promise<{ box: AsciiBoxInfo }>;
  remove(input: { boxId: string }, init?: RequestInit): Promise<unknown>;
  sshKey(
    input: { boxId: string; sshKeyRequest: { key: string } },
    init?: RequestInit,
  ): Promise<unknown>;
  stop(input: { boxId: string }, init?: RequestInit): Promise<unknown>;
}

interface AsciiBoxInfo {
  id: string;
  ip?: string | null;
  state: string;
}

const asciiExecutionAuthority = {
  credentials: "unknown",
  environment: "selected",
  filesystem: { access: "read-write", scope: "sandbox" },
  isolation: "unknown",
  network: "unknown",
  processes: "arbitrary",
} as const satisfies ExecutionAuthority;

export function createAsciiRuntime(
  options: AsciiBoxOptions = {},
  dependencies: AsciiRuntimeDependencies = {},
): BoxRuntime {
  const ttlSeconds = options.ttlSeconds ?? defaultAsciiTtlSeconds;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 7200 || ttlSeconds > 2_592_000)
    throw new TypeError("[vitehub] ASCII ttlSeconds must be an integer between 7200 and 2592000.");
  return markBuiltInBoxRuntime({
    name: "ascii",
    async prepare(input) {
      return remoteBoxPlan(input, {
        executionAuthority: asciiExecutionAuthority,
        runtime: "ascii",
      });
    },
    async open(input, openOptions) {
      openOptions.signal?.throwIfAborted();
      const apiKey = options.apiKey ?? process.env.BOX_API_KEY;
      if (!apiKey)
        throw new Error("[vitehub] The ASCII Box runtime requires apiKey or BOX_API_KEY.");
      const client = await (dependencies.createClient ?? loadAsciiClient)({
        apiKey,
        baseUrl: options.baseUrl ?? process.env.BOX_BASE_URL ?? defaultAsciiBaseUrl,
      });
      const created = await client.create(
        { createBoxRequest: { noEnv: true, ttlSeconds } },
        requestInit(AbortSignal.timeout(300_000)),
      );
      const boxId = created.box.id;
      let removePromise: Promise<void> | undefined;
      const removeBox = () => (removePromise ??= removeAsciiBox(client, boxId));
      let runtimeSession: RuntimeSession | undefined;
      try {
        openOptions.signal?.throwIfAborted();
        const box = await waitForAsciiBox(
          client,
          boxId,
          openOptions.signal,
          dependencies.provisioningTimeoutMs ?? 300_000,
        );
        const identity = await (dependencies.createIdentity ?? createAsciiSshIdentity)();
        await client.sshKey(
          { boxId, sshKeyRequest: { key: identity.publicKey } },
          requestInit(openOptions.signal),
        );
        const hostKeys = await readAsciiHostKeys(client, boxId, openOptions.signal);
        const transport = await connectAsciiSsh(
          dependencies.openSsh ?? openAsciiSshSession,
          {
            abortSignal: openOptions.signal,
            destroyBox: removeBox,
            host: box.ip!,
            hostKeys,
            identity,
          },
          openOptions.signal,
        );
        runtimeSession = withAsciiLifecycle(transport, boxId, removeBox, openOptions.id ?? boxId);
        await probeAsciiTransport(runtimeSession, openOptions.signal);
        const env = await resolveRemoteEnvironment(input, {
          home: "/home/user/.vitehub/home",
          workspace: "/home/user/.vitehub/workspace",
        });
        return await openRemoteBox(input, withBaseEnvironment(runtimeSession, env), {
          executionAuthority: openOptions.executionAuthority,
          home: "/home/user/.vitehub/home",
          initialize: openOptions.initialize,
          runtime: "ascii",
          signal: openOptions.signal,
          workspace: "/home/user/.vitehub/workspace",
        }, Object.keys(input.plan.env).map(name => env[name]));
      } catch (error) {
        if (runtimeSession) {
          try {
            await runtimeSession.destroy?.();
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "[vitehub] ASCII Box initialization and cleanup failed.",
            );
          }
          throw error;
        }
        try {
          await removeBox();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "[vitehub] ASCII Box initialization and cleanup failed.",
          );
        }
        throw error;
      }
    },
  });
}

async function loadAsciiClient(options: { apiKey: string; baseUrl: string }): Promise<AsciiClient> {
  try {
    const { BoxApi, Configuration } = await import(/* @vite-ignore */ asciiSdkPackage);
    return new BoxApi(
      new Configuration({
        accessToken: options.apiKey,
        basePath: options.baseUrl,
      }),
    ) as unknown as AsciiClient;
  } catch (error) {
    throw new Error(
      `[vitehub] The ASCII Box runtime requires @asciidev/box-sdk: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function waitForAsciiBox(
  client: AsciiClient,
  boxId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const provisioningSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let attempt = 0; attempt < 150; attempt++) {
    provisioningSignal.throwIfAborted();
    const { box } = await client.get({ boxId }, requestInit(provisioningSignal));
    if (["ready", "idle", "running"].includes(box.state) && box.ip) return box;
    if (box.state === "error")
      throw new Error(`[vitehub] ASCII Box ${boxId} entered the error state.`);
    if (box.state === "archived")
      throw new Error(`[vitehub] ASCII Box ${boxId} was archived during provisioning.`);
    await abortableDelay(2_000, provisioningSignal);
  }
  throw new Error(`[vitehub] ASCII Box ${boxId} did not become ready within five minutes.`);
}

async function readAsciiHostKeys(
  client: AsciiClient,
  boxId: string,
  signal: AbortSignal | undefined,
) {
  const result = await client.command(
    {
      boxId,
      commandRequest: {
        command: "sudo -n sh -c 'cat /etc/ssh/ssh_host_*_key.pub'",
        timeoutSeconds: 30,
      },
    },
    requestInit(signal),
  );
  if (
    result.timedOut ||
    result.exitCode !== 0 ||
    result.stdoutTruncated ||
    result.stderrTruncated
  ) {
    throw new Error(`[vitehub] ASCII could not retrieve complete SSH host keys: ${result.stderr}`);
  }
  return parseAsciiSshHostKeys(result.stdout);
}

async function connectAsciiSsh(
  open: (options: AsciiSshOptions) => Promise<RuntimeSession>,
  options: AsciiSshOptions,
  signal: AbortSignal | undefined,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    signal?.throwIfAborted();
    try {
      return await open(options);
    } catch (error) {
      lastError = error;
      if (!isRetryableSshError(error)) throw error;
      await abortableDelay(2_000, signal);
    }
  }
  throw new Error(
    `[vitehub] ASCII SSH did not become ready: ${lastError instanceof Error ? lastError.message : lastError}`,
  );
}

async function probeAsciiTransport(session: RuntimeSession, signal: AbortSignal | undefined) {
  const directory = `/home/user/.vitehub-probe-${crypto.randomUUID()}`;
  await session.makeDirectory({ abortSignal: signal, path: directory, recursive: false });
  try {
    const path = `${directory}/binary`;
    const expected = new Uint8Array([0, 1, 127, 128, 255]);
    await session.writeBinaryFile({ abortSignal: signal, content: expected, path });
    const actual = await session.readBinaryFile({ abortSignal: signal, path });
    if (
      !actual ||
      actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])
    ) {
      throw new Error("[vitehub] ASCII SFTP binary probe failed.");
    }
    const success = await session.run({
      abortSignal: signal,
      command: "printf vitehub-ascii",
      workingDirectory: directory,
    });
    if (success.exitCode !== 0 || success.stdout !== "vitehub-ascii")
      throw new Error("[vitehub] ASCII streamed command probe failed.");
    const failure = await session.run({
      abortSignal: signal,
      command: "exit 37",
      workingDirectory: directory,
    });
    if (failure.exitCode !== 37)
      throw new Error("[vitehub] ASCII command exit-status probe failed.");
    if (!session.spawn)
      throw new Error("[vitehub] ASCII SSH transport does not support long-running processes.");
    const process = await session.spawn({
      abortSignal: signal,
      command: "sleep 3600",
      workingDirectory: directory,
    });
    await process.kill("KILL");
    await process.wait();
  } finally {
    await session.removeFile({
      abortSignal: signal,
      path: directory,
      recursive: true,
    });
  }
}

function withBaseEnvironment(
  session: RuntimeSession,
  baseEnv: Record<string, string>,
): RuntimeSession {
  return {
    ...session,
    async run(options) {
      return await session.run({
        ...options,
        env: { ...baseEnv, ...options.env },
      });
    },
    ...(session.spawn
      ? {
          async spawn(options: Parameters<NonNullable<RuntimeSession["spawn"]>>[0]) {
            return await session.spawn!({
              ...options,
              env: { ...baseEnv, ...options.env },
            });
          },
        }
      : {}),
  };
}

function withAsciiLifecycle(
  transport: RuntimeSession,
  boxId: string,
  removeBox: () => Promise<void>,
  sessionId: string,
): RuntimeSession {
  let destroyPromise: Promise<void> | undefined;
  return {
    ...transport,
    id: sessionId,
    async destroy() {
      destroyPromise ??= closeAsciiBox(transport, boxId, removeBox);
      return await destroyPromise;
    },
  };
}

async function closeAsciiBox(
  transport: RuntimeSession,
  boxId: string,
  removeBox: () => Promise<void>,
) {
  const failures: unknown[] = [];
  try {
    await withTimeout(
      transport.stop(),
      10_000,
      `[vitehub] ASCII Box ${boxId} SSH teardown timed out.`,
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    await removeBox();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, `[vitehub] ASCII Box ${boxId} teardown failed.`);
}

async function removeAsciiBox(client: AsciiClient, boxId: string) {
  const removalSignal = AbortSignal.timeout(20_000);
  let removalError: unknown;
  try {
    await client.remove({ boxId }, requestInit(removalSignal));
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await client.get({ boxId }, requestInit(removalSignal));
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      await abortableDelay(500, removalSignal);
    }
    removalError = new Error(`[vitehub] ASCII Box ${boxId} still exists after deletion.`);
  } catch (error) {
    if (isNotFound(error)) return;
    removalError = error;
  }

  let containmentError: unknown;
  const containmentSignal = AbortSignal.timeout(10_000);
  try {
    await client.stop({ boxId }, requestInit(containmentSignal));
    await waitForArchived(client, boxId, containmentSignal);
  } catch (error) {
    containmentError = error;
  }
  throw new AggregateError(
    containmentError ? [removalError, containmentError] : [removalError],
    `[vitehub] ASCII Box ${boxId} could not be verified as deleted.`,
  );
}

async function waitForArchived(client: AsciiClient, boxId: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const { box } = await client.get({ boxId }, requestInit(signal));
      if (box.state === "archived") return;
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    await abortableDelay(500, signal);
  }
  throw new Error(`[vitehub] ASCII Box ${boxId} was not archived after deletion failed.`);
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  if ("status" in error && error.status === 404) return true;
  return (
    "response" in error &&
    !!error.response &&
    typeof error.response === "object" &&
    "status" in error.response &&
    error.response.status === 404
  );
}

function isRetryableSshError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  if (
    "code" in error &&
    ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ETIMEDOUT"].includes(String(error.code))
  ) {
    return true;
  }
  return error instanceof Error && error.message.includes("box_restoring");
}

function requestInit(signal: AbortSignal | undefined): RequestInit | undefined {
  return signal ? { signal } : undefined;
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined) {
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
