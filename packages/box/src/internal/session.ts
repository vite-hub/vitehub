import type {
  BoxExecOptions,
  BoxFileEntry,
  BoxProcess,
  BoxRuntimeOpenOptions,
  BoxSession,
} from "../index.ts";

export interface RuntimeProcess {
  readonly pid?: number;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  kill(signal?: string): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
}

export interface RuntimeSession {
  readonly defaultWorkingDirectory: string;
  readonly description?: string;
  readonly id: string;
  readonly ports?: readonly number[];
  destroy?(): Promise<void>;
  existsFile(options: { abortSignal?: AbortSignal; path: string }): Promise<boolean>;
  getPortUrl?(options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<string>;
  listFiles(options: {
    abortSignal?: AbortSignal;
    path: string;
    recursive?: boolean;
  }): Promise<readonly BoxFileEntry[]>;
  makeDirectory(options: {
    abortSignal?: AbortSignal;
    path: string;
    recursive?: boolean;
  }): Promise<void>;
  moveFile?(options: {
    abortSignal?: AbortSignal;
    destination: string;
    source: string;
  }): Promise<void>;
  readBinaryFile(options: {
    abortSignal?: AbortSignal;
    path: string;
  }): Promise<Uint8Array | null>;
  readFile?(options: {
    abortSignal?: AbortSignal;
    path: string;
  }): Promise<ReadableStream<Uint8Array> | null>;
  readTextFile?(options: {
    abortSignal?: AbortSignal;
    encoding?: string;
    endLine?: number;
    path: string;
    startLine?: number;
  }): Promise<string | null>;
  restricted?(): RuntimeSession;
  removeFile(options: {
    abortSignal?: AbortSignal;
    path: string;
    recursive?: boolean;
  }): Promise<void>;
  run(options: RuntimeCommandOptions): Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
  }>;
  spawn?(options: RuntimeCommandOptions): Promise<RuntimeProcess>;
  stop(): Promise<void>;
  writeBinaryFile(options: {
    abortSignal?: AbortSignal;
    content: Uint8Array;
    path: string;
  }): Promise<void>;
  writeFile?(options: {
    abortSignal?: AbortSignal;
    content: ReadableStream<Uint8Array>;
    path: string;
  }): Promise<void>;
  writeTextFile?(options: {
    abortSignal?: AbortSignal;
    content: string;
    encoding?: string;
    path: string;
  }): Promise<void>;
}

interface RuntimeCommandOptions {
  abortSignal?: AbortSignal;
  command: string;
  env?: Record<string, string>;
  workingDirectory?: string;
}

export function createBoxSession(
  runtime: RuntimeSession,
  openOptions: BoxRuntimeOpenOptions,
  cwd: string = runtime.defaultWorkingDirectory,
): BoxSession {
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error("[vitehub] Box session is closed.");
  };
  const operationSignal = (signal?: AbortSignal, timeout?: number) => {
    assertOpen();
    const signals = [openOptions.signal, signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    if (timeout !== undefined) {
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new TypeError("[vitehub] Box command timeout must be a positive number.");
      signals.push(AbortSignal.timeout(timeout));
    }
    const combined = signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);
    combined?.throwIfAborted();
    return combined;
  };

  const session: BoxSession = {
    cwd,
    executionAuthority: openOptions.executionAuthority,
    files: {
      async exists(path, options) {
        return await runtime.existsFile({
          abortSignal: operationSignal(options?.signal),
          path,
        });
      },
      async list(path, options) {
        return await runtime.listFiles({
          abortSignal: operationSignal(options?.signal),
          path,
          recursive: options?.recursive,
        });
      },
      async mkdir(path, options) {
        await runtime.makeDirectory({
          abortSignal: operationSignal(options?.signal),
          path,
          recursive: options?.recursive,
        });
      },
      ...(runtime.moveFile
        ? {
            async move(source: string, destination: string, options?: { signal?: AbortSignal }) {
              await runtime.moveFile!({
                abortSignal: operationSignal(options?.signal),
                destination,
                source,
              });
            },
          }
        : {}),
      async read(path, options) {
        const contents = await runtime.readBinaryFile({
          abortSignal: operationSignal(options?.signal),
          path,
        });
        return contents === null ? null : new Uint8Array(contents);
      },
      async remove(path, options) {
        await runtime.removeFile({
          abortSignal: operationSignal(options?.signal),
          path,
          recursive: options?.recursive,
        });
      },
      async write(path, contents, options) {
        await runtime.writeBinaryFile({
          abortSignal: operationSignal(options?.signal),
          content: contents,
          path,
        });
      },
    },
    id: runtime.id,
    ...(runtime.getPortUrl
      ? {
          ports: {
            values: runtime.ports ?? [0],
            async expose(port: number, options?: { protocol?: "http" | "https" | "ws" }) {
              assertPort(port);
              return new URL(await runtime.getPortUrl!({ port, protocol: options?.protocol }));
            },
          },
        }
      : {}),
    ...(runtime.spawn
      ? {
          async spawn(command: string, args: readonly string[] = [], options?: BoxExecOptions) {
            const process = await runtime.spawn!({
              abortSignal: operationSignal(options?.signal, options?.timeout),
              command: commandLine(command, args),
              env: options?.env ? { ...options.env } : undefined,
              workingDirectory: options?.cwd ?? cwd,
            });
            return adaptProcess(process);
          },
        }
      : {}),
    async close() {
      if (closePromise) return await closePromise;
      closed = true;
      closePromise = runtime.destroy ? runtime.destroy() : runtime.stop();
      return await closePromise;
    },
    async exec(command, args = [], options) {
      const result = await runtime.run({
        abortSignal: operationSignal(options?.signal, options?.timeout),
        command: commandLine(command, args),
        env: options?.env ? { ...options.env } : undefined,
        workingDirectory: options?.cwd ?? cwd,
      });
      return {
        code: result.exitCode,
        ok: result.exitCode === 0,
        stderr: result.stderr,
        stdout: result.stdout,
      };
    },
  };
  return Object.freeze(session);
}

function adaptProcess(process: RuntimeProcess): BoxProcess {
  return {
    pid: process.pid,
    stderr: process.stderr,
    stdout: process.stdout,
    async kill(signal?: string) {
      await process.kill(signal);
    },
    async wait() {
      const result = await process.wait();
      return { code: result.exitCode };
    },
  };
}

function commandLine(command: string, args: readonly string[]) {
  if (!command || command.includes("\0"))
    throw new TypeError("[vitehub] Box commands must be non-empty and cannot contain NUL.");
  if (args.some((argument) => argument.includes("\0")))
    throw new TypeError("[vitehub] Box command arguments cannot contain NUL.");
  return args.length === 0
    ? command
    : [shellQuote(command), ...args.map(shellQuote)].join(" ");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new TypeError("[vitehub] Box ports must be integers between 1 and 65535.");
}
