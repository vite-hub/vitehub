import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Readable } from "node:stream";
import type { BoxFileEntry } from "../index.ts";
import { shellQuote } from "./remote.ts";
import type { RuntimeProcess, RuntimeSession } from "./session.ts";

const ssh2Package = "ssh2";
const allowedSignals = new Set(["HUP", "INT", "KILL", "QUIT", "TERM"]);
const signalExitCodes: Readonly<Record<string, number>> = {
  HUP: 129,
  INT: 130,
  KILL: 137,
  QUIT: 131,
  TERM: 143,
};

export interface AsciiSshIdentity {
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface AsciiSshOptions {
  readonly abortSignal?: AbortSignal;
  readonly destroyBox: () => Promise<void>;
  readonly host: string;
  readonly hostKeys: readonly Uint8Array[];
  readonly identity: AsciiSshIdentity;
  readonly port?: number;
}

export async function createAsciiSshIdentity(): Promise<AsciiSshIdentity> {
  const ssh2 = await loadSsh2();
  const generated = ssh2.utils.generateKeyPairSync("rsa", {
    bits: 3072,
    comment: `vitehub-${randomUUID()}`,
  });
  return {
    privateKey: generated.private,
    publicKey: generated.public,
  };
}

export function parseAsciiSshHostKeys(output: string): readonly Uint8Array[] {
  const keys = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [type, encoded] = line.split(/\s+/);
      if (!type || !/^[A-Za-z0-9@._+-]+$/.test(type) || !encoded)
        throw new Error("[vitehub] ASCII returned an invalid SSH host public key.");
      const key = Buffer.from(encoded, "base64");
      if (
        key.length === 0 ||
        key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
      )
        throw new Error("[vitehub] ASCII returned an invalid SSH host public key.");
      if (key.length < 5)
        throw new Error("[vitehub] ASCII returned an invalid SSH host public key.");
      const typeLength = key.readUInt32BE(0);
      if (
        typeLength <= 0 ||
        typeLength + 4 >= key.length ||
        key.subarray(4, 4 + typeLength).toString() !== type
      ) {
        throw new Error("[vitehub] ASCII returned an invalid SSH host public key.");
      }
      return new Uint8Array(key);
    });
  if (keys.length === 0) throw new Error("[vitehub] ASCII returned no SSH host public keys.");
  return keys;
}

export async function openAsciiSshSession(
  options: AsciiSshOptions,
  loadModule: () => Promise<Ssh2Module> = loadSsh2,
): Promise<RuntimeSession> {
  const ssh2 = await loadModule();
  const client = new ssh2.Client();
  let destroyPromise: Promise<void> | undefined;
  const destroyBox = () => (destroyPromise ??= options.destroyBox());
  const fault = createTransportFault(destroyBox);
  await connect(client, options, fault.record);
  try {
    const sftp = await waitWithTimeout(
      openSftp(client),
      20_000,
      "[vitehub] ASCII SFTP negotiation timed out.",
      options.abortSignal,
    );
    return createAsciiSshSession(client, sftp, destroyBox, fault);
  } catch (error) {
    client.destroy();
    throw error;
  }
}

async function loadSsh2(): Promise<Ssh2Module> {
  try {
    const imported = await import(/* @vite-ignore */ ssh2Package);
    return {
      Client: imported.Client,
      utils: imported.default.utils,
    } as unknown as Ssh2Module;
  } catch (error) {
    throw new Error(
      `[vitehub] The ASCII Box runtime requires ssh2: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function connect(
  client: SshClient,
  options: AsciiSshOptions,
  onTransportError: (error: Error) => void,
) {
  const expectedKeys = options.hostKeys.map((key) => Buffer.from(key));
  options.abortSignal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const onAbort = () => {
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
      client.destroy();
      reject(options.abortSignal!.reason);
    };
    const onReady = () => {
      ready = true;
      client.removeListener("ready", onReady);
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onError = (error: Error) => {
      if (ready) {
        onTransportError(error);
      } else {
        client.removeListener("ready", onReady);
        client.removeListener("error", onError);
        options.abortSignal?.removeEventListener("abort", onAbort);
        client.destroy();
        reject(error);
      }
    };
    client.on("ready", onReady);
    client.on("error", onError);
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (options.abortSignal?.aborted) {
      onAbort();
      return;
    }
    client.connect({
      host: options.host,
      hostVerifier(key) {
        return expectedKeys.some(
          (expected) => expected.length === key.length && expected.equals(key),
        );
      },
      keepaliveCountMax: 6,
      keepaliveInterval: 10_000,
      port: options.port ?? 22,
      privateKey: options.identity.privateKey,
      readyTimeout: 20_000,
      username: "user",
    });
  });
}

async function openSftp(client: SshClient) {
  return await new Promise<SftpClient>((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(error);
      else resolve(sftp);
    });
  });
}

function createAsciiSshSession(
  client: SshClient,
  sftp: SftpClient,
  destroyBox: () => Promise<void>,
  fault: TransportFault,
): RuntimeSession {
  const workspace = "/home/user/.vitehub/workspace";
  const processes = new Set<ReturnType<typeof createRuntimeProcess>>();
  let closed = false;

  const assertOpen = () => {
    fault.throwIfFailed();
    if (closed) throw new Error("[vitehub] ASCII SSH transport is closed.");
  };
  const exec = async (command: string) => {
    assertOpen();
    return await openChannel(client, command);
  };
  const spawn = async (options: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    workingDirectory?: string;
  }) => {
    assertOpen();
    options.abortSignal?.throwIfAborted();
    const launchScript = launchScriptContents(options);
    const unit = `vitehub-${randomUUID()}.service`;
    let channel: SshChannel;
    try {
      channel = await waitWithTimeout(
        exec(systemdRunCommand(unit, options.workingDirectory)),
        10_000,
        `[vitehub] ASCII process ${unit} launch timed out.`,
        options.abortSignal,
      );
    } catch (error) {
      return await failClosed(error, destroyBox, `[vitehub] ASCII process ${unit} launch failed.`);
    }
    const process = createRuntimeProcess(
      unit,
      channel,
      async (command) =>
        await waitWithTimeout(
          exec(command).then(async (channel) => await collectChannel(channel)),
          10_000,
          `[vitehub] ASCII SSH control command timed out for ${unit}.`,
        ),
      destroyBox,
    );
    processes.add(process);
    void process.settled.finally(() => processes.delete(process));
    try {
      await Promise.all([
        waitWithTimeout(
          endChannel(channel, launchScript),
          10_000,
          `[vitehub] ASCII process ${unit} launch input timed out.`,
          options.abortSignal,
        ),
        process.ready,
      ]);
    } catch (error) {
      return await failClosed(error, destroyBox, `[vitehub] ASCII process ${unit} launch failed.`);
    }
    if (options.abortSignal) {
      const onAbort = () => void process.kill("KILL").catch(() => undefined);
      options.abortSignal.addEventListener("abort", onAbort, { once: true });
      if (options.abortSignal.aborted) onAbort();
      void process.settled.finally(() =>
        options.abortSignal?.removeEventListener("abort", onAbort),
      );
    }
    options.abortSignal?.throwIfAborted();
    return process;
  };
  const run = async (options: {
    abortSignal?: AbortSignal;
    command: string;
    env?: Record<string, string>;
    workingDirectory?: string;
  }) => {
    const process = await spawn(options);
    const [result, stdout, stderr] = await Promise.all([
      process.wait(),
      readStream(process.stdout),
      readStream(process.stderr),
    ]);
    options.abortSignal?.throwIfAborted();
    return { exitCode: result.exitCode, stderr, stdout };
  };

  return {
    defaultWorkingDirectory: workspace,
    id: `ascii-ssh-${randomUUID()}`,
    async existsFile({ abortSignal, path }) {
      return (
        (
          await run({
            abortSignal,
            command: `test -e ${shellQuote(path)}`,
            workingDirectory: "/home/user",
          })
        ).exitCode === 0
      );
    },
    async listFiles({ abortSignal, path, recursive }) {
      const result = await run({
        abortSignal,
        command: `find ${shellQuote(path)} -mindepth 1 ${recursive ? "" : "-maxdepth 1 "}-printf '%y\\t%s\\t%p\\0'`,
        workingDirectory: "/home/user",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
      return parseAsciiFileList(result.stdout);
    },
    async makeDirectory({ abortSignal, path, recursive }) {
      const result = await run({
        abortSignal,
        command: `mkdir ${recursive ? "-p " : ""}-- ${shellQuote(path)}`,
        workingDirectory: "/home/user",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    },
    async moveFile({ abortSignal, destination, source }) {
      const result = await run({
        abortSignal,
        command: `mv -- ${shellQuote(source)} ${shellQuote(destination)}`,
        workingDirectory: "/home/user",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    },
    async readBinaryFile({ abortSignal, path }) {
      assertOpen();
      try {
        return new Uint8Array(
          await sftpCall<Buffer>(abortSignal, client, fault.record, (callback) =>
            sftp.readFile(path, callback),
          ),
        );
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },
    async removeFile({ abortSignal, path, recursive }) {
      const result = await run({
        abortSignal,
        command: recursive
          ? `rm -rf -- ${shellQuote(path)}`
          : `if test -d ${shellQuote(path)}; then rmdir -- ${shellQuote(path)}; else rm -f -- ${shellQuote(path)}; fi`,
        workingDirectory: "/home/user",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr);
    },
    run,
    spawn,
    async stop() {
      if (closed) return;
      const failures: unknown[] = [];
      const stopped = await Promise.allSettled(
        Array.from(processes, (process) => process.kill("KILL")),
      );
      failures.push(
        ...stopped
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason),
      );
      closed = true;
      await fault.cleanup;
      if (fault.error) failures.push(fault.error);
      try {
        sftp.end?.();
        client.end();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, "[vitehub] ASCII SSH teardown failed.");
    },
    async writeBinaryFile({ abortSignal, content, path }) {
      assertOpen();
      await sftpCall<void>(abortSignal, client, fault.record, (callback) =>
        sftp.writeFile(path, Buffer.from(content), callback),
      );
    },
  };
}

function systemdRunCommand(unit: string, workingDirectory?: string) {
  const args = [
    "sudo",
    "-n",
    "systemd-run",
    "--quiet",
    "--pipe",
    "--wait",
    "--collect",
    "--service-type=exec",
    `--unit=${unit}`,
    "--uid=user",
    "--gid=user",
    `--working-directory=${workingDirectory ?? "/home/user/.vitehub/workspace"}`,
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=10s",
    "--",
    "/bin/sh",
    "-s",
  ];
  return args.map(shellQuote).join(" ");
}

function launchScriptContents(options: { command: string; env?: Record<string, string> }) {
  const exports = Object.entries(options.env ?? {}).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`[vitehub] Invalid environment variable name: ${JSON.stringify(name)}.`);
    }
    return `export ${shellQuote(`${name}=${value}`)}`;
  });
  return [...exports, `exec /bin/sh -lc ${shellQuote(options.command)}`, ""].join("\n");
}

function createRuntimeProcess(
  unit: string,
  channel: SshChannel,
  executeControl: (
    command: string,
  ) => Promise<{ exitCode: number; stderr: string; stdout: string }>,
  destroyBox: () => Promise<void>,
) {
  let state: "launching" | "observed" | "terminal" = "launching";
  let exitCode: number | undefined;
  let killedExitCode: number | undefined;
  let closeError: Error | undefined;
  const settled = new Promise<void>((resolve) => {
    channel.once("exit", (code: number | undefined) => {
      if (typeof code === "number") exitCode = code;
    });
    channel.once("error", (error) => {
      closeError = error;
    });
    channel.once("close", (code: number | undefined) => {
      if (typeof code === "number") exitCode = code;
      state = "terminal";
      resolve();
    });
  });
  const observed = observeUnit(unit, executeControl, () => state === "terminal").then((active) => {
    if (state === "launching" && active) state = "observed";
    return active;
  });
  const isTerminal = () => state === "terminal";
  const ready = observed
    .then(async (active) => {
      if (active || isTerminal()) return;
      throw new Error(`[vitehub] ASCII process ${unit} could not be observed after launch.`);
    })
    .catch(async (error) => {
      await failClosed(error, destroyBox, `[vitehub] ASCII process ${unit} launch failed.`);
    });

  const process = {
    ready,
    settled,
    stderr: toReadableStream(channel.stderr),
    stdout: toReadableStream(channel),
    async kill(signal?: string) {
      const normalized = normalizeSignal(signal);
      await observed;
      if (isTerminal()) return;
      let result: { exitCode: number; stderr: string; stdout: string };
      try {
        result = await executeControl(
          [
            "sudo -n systemctl kill",
            "--kill-whom=all",
            `--signal=SIG${normalized}`,
            shellQuote(unit),
          ].join(" "),
        );
      } catch (error) {
        return await failClosed(error, destroyBox, `[vitehub] ASCII could not kill ${unit}.`);
      }
      if (result.exitCode !== 0) {
        await Promise.race([settled, delay(250)]);
        if (!isTerminal()) {
          await destroyBox();
          throw new Error(`[vitehub] ASCII could not kill ${unit}: ${result.stderr}`);
        }
      }
      killedExitCode = signalExitCodes[normalized];
      await waitWithTimeout(
        settled,
        10_000,
        `[vitehub] ASCII process ${unit} did not terminate.`,
      ).catch(async (error) => {
        await destroyBox();
        throw error;
      });
      try {
        await verifyUnitStopped(unit, executeControl);
      } catch (error) {
        await destroyBox();
        throw error;
      }
    },
    async wait() {
      await settled;
      if (closeError) throw closeError;
      if (exitCode === undefined)
        throw new Error(`[vitehub] ASCII process ${unit} closed without an exit status.`);
      return { exitCode: killedExitCode ?? exitCode };
    },
  } satisfies RuntimeProcess & { ready: Promise<void>; settled: Promise<void> };
  return process;
}

async function observeUnit(
  unit: string,
  executeControl: (
    command: string,
  ) => Promise<{ exitCode: number; stderr: string; stdout: string }>,
  terminal: () => boolean,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (terminal()) return false;
    const result = await executeControl(
      `sudo -n systemctl show --property=LoadState --property=ActiveState --value ${shellQuote(unit)}`,
    );
    if (result.exitCode === 0 && !result.stdout.includes("not-found")) return true;
    await delay(25);
  }
  return false;
}

async function verifyUnitStopped(
  unit: string,
  executeControl: (
    command: string,
  ) => Promise<{ exitCode: number; stderr: string; stdout: string }>,
) {
  const result = await executeControl(
    [
      "sudo -n systemctl show",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=ControlGroup",
      shellQuote(unit),
    ].join(" "),
  );
  if (result.exitCode !== 0)
    throw new Error(`[vitehub] ASCII could not verify ${unit}: ${result.stderr}`);
  const properties = new Map(
    result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator === -1
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  if (properties.get("LoadState") === "not-found") return;
  if (properties.get("LoadState") !== "loaded")
    throw new Error(`[vitehub] ASCII process ${unit} has an unknown systemd load state.`);
  const activeState = properties.get("ActiveState");
  const controlGroup = properties.get("ControlGroup");
  if (activeState && !["failed", "inactive"].includes(activeState))
    throw new Error(`[vitehub] ASCII process ${unit} remains ${activeState}.`);
  if (controlGroup) {
    const processes = posix.join("/sys/fs/cgroup", controlGroup, "cgroup.procs");
    const check = await executeControl(
      `test ! -e ${shellQuote(processes)} || test -z "$(cat ${shellQuote(processes)})"`,
    );
    if (check.exitCode !== 0)
      throw new Error(`[vitehub] ASCII process ${unit} left a non-empty cgroup.`);
  }
}

async function openChannel(client: SshClient, command: string) {
  return await new Promise<SshChannel>((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error) reject(error);
      else resolve(channel);
    });
  });
}

async function endChannel(channel: SshChannel, contents: string) {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      channel.removeListener("error", onError);
      reject(error);
    };
    channel.once("error", onError);
    channel.end(contents, (error) => {
      channel.removeListener("error", onError);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function collectChannel(channel: SshChannel) {
  let exitCode: number | undefined;
  const [stdout, stderr] = await Promise.all([
    readStream(toReadableStream(channel)),
    readStream(toReadableStream(channel.stderr)),
    new Promise<void>((resolve, reject) => {
      channel.once("exit", (code: number | undefined) => {
        if (typeof code === "number") exitCode = code;
      });
      channel.once("error", reject);
      channel.once("close", (code: number | undefined) => {
        if (typeof code === "number") exitCode = code;
        resolve();
      });
    }),
  ]);
  if (exitCode === undefined)
    throw new Error("[vitehub] ASCII SSH command closed without an exit status.");
  return { exitCode, stderr, stdout };
}

async function readStream(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function toReadableStream(stream: Readable): ReadableStream<Uint8Array> {
  let cancel: (() => void) | undefined;
  let resume: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const cleanup = () => {
        stream.removeListener("close", onClose);
        stream.removeListener("data", onData);
        stream.removeListener("end", onClose);
        stream.removeListener("error", onError);
      };
      const onClose = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      const onData = (chunk: Buffer | string) => {
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) stream.pause();
      };
      const onError = (error: Error) => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.error(error);
      };
      cancel = () => {
        if (closed) return;
        closed = true;
        cleanup();
        stream.resume();
      };
      resume = () => stream.resume();
      stream.on("close", onClose);
      stream.on("data", onData);
      stream.on("end", onClose);
      stream.on("error", onError);
    },
    pull() {
      resume?.();
    },
    cancel() {
      cancel?.();
    },
  });
}

async function sftpCall<T>(
  signal: AbortSignal | undefined,
  client: SshClient,
  onTransportError: (error: unknown) => void,
  start: (callback: (error: NodeJS.ErrnoException | null, value: T) => void) => void,
) {
  signal?.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      onTransportError(signal!.reason);
      client.destroy();
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    start((error, value) => {
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    });
  });
}

interface TransportFault {
  readonly cleanup: Promise<void>;
  readonly error: unknown;
  record(error: unknown): void;
  throwIfFailed(): void;
}

function createTransportFault(destroyBox: () => Promise<void>): TransportFault {
  let cleanup = Promise.resolve();
  let error: unknown;
  return {
    get cleanup() {
      return cleanup;
    },
    get error() {
      return error;
    },
    record(failure) {
      if (error !== undefined) return;
      const transportError =
        failure ?? new Error("[vitehub] ASCII SSH transport failed without an error.");
      error = transportError;
      cleanup = destroyBox().catch((cleanupError) => {
        error = new AggregateError(
          [transportError, cleanupError],
          "[vitehub] ASCII SSH transport and provider cleanup failed.",
        );
      });
    },
    throwIfFailed() {
      if (error !== undefined) throw error;
    },
  };
}

export function parseAsciiFileList(output: string): BoxFileEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const kindSeparator = line.indexOf("\t");
      const sizeSeparator = line.indexOf("\t", kindSeparator + 1);
      const kind = line.slice(0, kindSeparator);
      const size = line.slice(kindSeparator + 1, sizeSeparator);
      const path = line.slice(sizeSeparator + 1);
      return {
        path,
        size: kind === "f" ? Number(size) : undefined,
        type:
          kind === "d"
            ? ("directory" as const)
            : kind === "l"
              ? ("symlink" as const)
              : ("file" as const),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeSignal(signal = "TERM") {
  const normalized = signal.toUpperCase().replace(/^SIG/, "");
  if (!allowedSignals.has(normalized))
    throw new TypeError(`[vitehub] Unsupported ASCII process signal: ${signal}`);
  return normalized;
}

function isMissingFile(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === 2)
  );
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(message));
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void promise.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error) => {
        finish();
        reject(error);
      },
    );
  });
}

async function failClosed(
  error: unknown,
  destroyBox: () => Promise<void>,
  message: string,
): Promise<never> {
  try {
    await destroyBox();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], message);
  }
  throw error;
}

interface Ssh2Module {
  Client: new () => SshClient;
  utils: {
    generateKeyPairSync(
      type: "rsa",
      options: { bits: 3072; comment: string },
    ): { private: string; public: string };
  };
}

interface SshClient {
  connect(options: {
    host: string;
    hostVerifier: (key: Buffer) => boolean;
    keepaliveCountMax: number;
    keepaliveInterval: number;
    port: number;
    privateKey: string;
    readyTimeout: number;
    username: string;
  }): void;
  destroy(): void;
  end(): void;
  exec(command: string, callback: (error: Error | null, channel: SshChannel) => void): void;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "ready", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "ready", listener: () => void): this;
  sftp(callback: (error: Error | null, sftp: SftpClient) => void): void;
}

interface SshChannel extends Readable {
  readonly stderr: Readable;
  end(contents: string, callback: (error?: Error | null) => void): this;
}

interface SftpClient {
  end?(): void;
  readFile(
    path: string,
    callback: (error: NodeJS.ErrnoException | null, contents: Buffer) => void,
  ): void;
  writeFile(
    path: string,
    contents: Buffer,
    callback: (error: NodeJS.ErrnoException | null, value: void) => void,
  ): void;
}
