// The Durable Object that backs the built-in Cloudflare Sandbox runtime.
// @cloudflare/sandbox 1.0 no longer ships a Sandbox class: the application's Durable Object starts
// its Container through `ctx.container` and uses `Files` for file operations. This class implements
// the `CloudflareSandboxStub` contract that `createCloudflareRuntime` calls over Durable Object RPC.
// Its base class and `Files` are injected, so this module imports neither `cloudflare:workers` nor
// `@cloudflare/sandbox` and tests can run it in Node.

export interface CloudflareContainerExecProcess {
  readonly exitCode: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly stdin: WritableStream<Uint8Array> | null;
  readonly stdout: ReadableStream<Uint8Array> | null;
  kill(signal?: number): void;
  output(): Promise<{ exitCode: number; stderr: ArrayBuffer; stdout: ArrayBuffer }>;
}

/** The part of the Workers `Container` API this Durable Object uses. */
export interface CloudflareContainer {
  readonly running: boolean;
  destroy(error?: unknown): Promise<void>;
  exec(command: string[], options?: {
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
    stderr?: "pipe" | "ignore" | "combined";
    stdin?: ReadableStream | "pipe";
    stdout?: "pipe" | "ignore";
  }): Promise<CloudflareContainerExecProcess>;
  setInactivityTimeout(durationMs: number | bigint): Promise<void>;
  start(options?: { enableInternet?: boolean; labels?: Record<string, string> }): void;
}

export interface CloudflareDurableObjectState {
  readonly container?: CloudflareContainer;
  readonly id: { toString(): string; readonly name?: string };
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  };
}

/** The part of `@cloudflare/sandbox` `Files` this Durable Object uses. */
export interface CloudflareSandboxFiles {
  mkdir(path: string, options?: { cwd?: string; recursive?: boolean }): Promise<void>;
  readFile(path: string, options?: { cwd?: string }): Promise<Response>;
  remove(path: string, options?: { cwd?: string; force?: boolean; recursive?: boolean }): Promise<void>;
  rename(source: string, destination: string, options?: { cwd?: string }): Promise<void>;
  stat(path: string, options?: { cwd?: string }): Promise<unknown>;
  writeFile(path: string, content: Uint8Array, options?: { cwd?: string }): Promise<void>;
}

export interface CloudflareSandboxDurableObjectDependencies {
  DurableObject: abstract new (ctx: any, env: any) => object;
  Files: new (container: Pick<CloudflareContainer, "exec">) => CloudflareSandboxFiles;
  SandboxFileError: { is(cause: unknown): cause is Error & { code: string } };
}

export interface CloudflareSandboxConfiguration {
  keepAlive?: boolean;
  sleepAfter?: number | string;
}

const configurationKey = "vitehub:configuration";
const defaultSleepAfter = 10 * 60_000;
// The Container API has no "never" timeout; use its maximum supported idle duration.
const keepAliveTimeout = 6 * 60 * 60_000;
const fileOptions = { cwd: "/workspace" };
// Output kept per stream for replay to late readers. Older output is dropped beyond this.
const maxBufferedOutput = 8 * 1024 * 1024;
const maxCancelledExecs = 1024;
const signals: Record<string, number> = { ALRM: 14, HUP: 1, INT: 2, KILL: 9, QUIT: 3, TERM: 15, USR1: 10, USR2: 12 };

// Keep timeout's monitored shell alive until both output pipes reach EOF, including
// output inherited by background descendants after the command shell has exited.
const timedExecShell = `
exec 3> >(cat)
stdoutPid=$!
exec 4> >(cat >&2 3>&-)
stderrPid=$!
/bin/bash -c "$1" >&3 2>&4 3>&- 4>&-
status=$?
exec 3>&- 4>&-
wait "$stdoutPid" "$stderrPid"
exit "$status"
`;

type OutputEvent = { data: string; type: "stderr" | "stdout" } | { exitCode: number; type: "exit" } | { data: string; type: "error" };

class SandboxProcessRecord {
  readonly exited: Promise<number>;
  readonly #events: OutputEvent[] = [];
  readonly #listeners = new Set<(event: OutputEvent) => void>();
  readonly #output = { stderr: "", stdout: "" };
  #buffered = 0;
  #done = false;

  constructor(readonly process: CloudflareContainerExecProcess) {
    const pumps = (["stdout", "stderr"] as const).map(type => this.#pump(type, process[type]));
    this.exited = process.exitCode;
    void Promise.allSettled(pumps)
      .then(async (results) => {
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
        }
        return { exitCode: await process.exitCode, type: "exit" as const };
      })
      .catch((error: unknown) => ({ data: error instanceof Error ? error.message : String(error), type: "error" as const }))
      .then((event) => {
        this.#emit(event);
        this.#done = true;
        this.#listeners.clear();
      });
  }

  logs() {
    return { ...this.#output };
  }

  /** Server-sent events: buffered output, then live output, then `exit`. Same format as @cloudflare/sandbox 0.12. */
  stream(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let listener: ((event: OutputEvent) => void) | undefined;
    return new ReadableStream({
      type: "bytes",
      start: (controller) => {
        const send = (event: OutputEvent) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (event.type === "exit" || event.type === "error") controller.close();
        };
        for (const event of this.#events) send(event);
        if (this.#done) return;
        listener = send;
        this.#listeners.add(listener);
      },
      cancel: () => {
        if (listener) this.#listeners.delete(listener);
      },
    });
  }

  async #pump(type: "stderr" | "stdout", stream: ReadableStream<Uint8Array> | null) {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      const data = decoder.decode(chunk, { stream: true });
      if (data) this.#append(type, data);
    }
    const rest = decoder.decode();
    if (rest) this.#append(type, rest);
  }

  #append(type: "stderr" | "stdout", data: string) {
    this.#output[type] += data;
    if (this.#output[type].length > maxBufferedOutput)
      this.#output[type] = this.#output[type].slice(-maxBufferedOutput);
    this.#emit({ data, type });
  }

  #emit(event: OutputEvent) {
    this.#events.push(event);
    this.#buffered += "data" in event ? event.data.length : 0;
    while (this.#buffered > 2 * maxBufferedOutput && this.#events.length > 1) {
      const dropped = this.#events.shift()!;
      this.#buffered -= "data" in dropped ? dropped.data.length : 0;
    }
    for (const listener of this.#listeners) listener(event);
  }
}

/** The RPC methods of the generated Sandbox Durable Object, matching `CloudflareSandboxStub`. */
export interface CloudflareSandboxDurableObject {
  configure(configuration: CloudflareSandboxConfiguration): Promise<void>;
  deleteFile(path: string): Promise<{ success: boolean }>;
  destroy(): Promise<void>;
  /** Stops the `exec` command started with this `id`. The Container and other commands keep running. */
  cancelExec(id: string): Promise<void>;
  exec(command: string, options?: CloudflareExecOptions): Promise<{
    exitCode: number;
    stderr: string;
    stdout: string;
    success: boolean;
  }>;
  exists(path: string): Promise<{ exists: boolean }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<{ success: boolean }>;
  moveFile(source: string, destination: string): Promise<{ success: boolean }>;
  readFile(path: string, options?: { encoding?: string }): Promise<{ content: string; success: boolean }>;
  startProcess(command: string, options?: { cwd?: string; env?: Record<string, string>; stdin?: boolean }): Promise<{
    getLogs(): Promise<{ stderr: string; stdout: string }>;
    id: string;
    kill(signal?: string): Promise<void>;
    stdin?: WritableStream<Uint8Array>;
    waitForExit(): Promise<{ exitCode: number }>;
  }>;
  streamProcessLogs(processId: string): Promise<ReadableStream<Uint8Array>>;
  writeFile(path: string, contents: string, options?: { encoding?: string }): Promise<{ success: boolean }>;
}

export interface CloudflareExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Names the command for `cancelExec`. */
  id?: string;
  timeout?: number;
}

export function createCloudflareSandboxDurableObject(
  dependencies: CloudflareSandboxDurableObjectDependencies,
): new (ctx: CloudflareDurableObjectState, env: unknown) => CloudflareSandboxDurableObject {
  const { DurableObject, Files, SandboxFileError } = dependencies;
  const missing = (cause: unknown) => SandboxFileError.is(cause) && cause.code === "ENOENT";

  return class ViteHubCloudflareSandbox extends DurableObject implements CloudflareSandboxDurableObject {
    readonly #ctx: CloudflareDurableObjectState;
    readonly #processes = new Map<string, SandboxProcessRecord>();
    readonly #execs = new Map<string, { process: CloudflareContainerExecProcess; timed: boolean }>();
    // Cancellations that arrived before their exec started its process.
    readonly #cancelled = new Set<string>();
    #configuration: Promise<CloudflareSandboxConfiguration> | undefined;
    #files: CloudflareSandboxFiles | undefined;

    constructor(ctx: CloudflareDurableObjectState, env: unknown) {
      super(ctx, env);
      this.#ctx = ctx;
    }

    /** Stores the idle policy. Applied now when the Container runs, otherwise when it starts. */
    async configure(configuration: CloudflareSandboxConfiguration) {
      this.#configuration = Promise.resolve(configuration);
      await this.#ctx.storage.put(configurationKey, configuration);
      if (this.#ctx.container?.running) await this.#applyConfiguration();
    }

    async destroy() {
      for (const record of this.#processes.values()) record.process.kill(signals.KILL);
      this.#processes.clear();
      const container = this.#container();
      if (container.running) await container.destroy();
    }

    async cancelExec(id: string) {
      const exec = this.#execs.get(id);
      if (!exec) {
        // A cancellation can also arrive after its command ended. Keep only recent ids.
        this.#cancelled.add(id);
        if (this.#cancelled.size > maxCancelledExecs) this.#cancelled.delete(this.#cancelled.values().next().value!);
        return;
      }
      // GNU timeout handles SIGALRM as its deadline: it kills the command's whole process group.
      exec.process.kill(exec.timed ? signals.ALRM : signals.KILL);
    }

    async exec(command: string, options: CloudflareExecOptions = {}) {
      const container = await this.#running();
      if (options.id && this.#cancelled.delete(options.id)) throw new DOMException("Command was cancelled before it started.", "AbortError");
      let timedOut = false;
      const timer = options.timeout ? setTimeout(() => { timedOut = true; }, options.timeout) : undefined;
      try {
        const commandLine = ["/bin/bash", "-c", command];
        // Native exec cancellation only kills the started process. GNU timeout kills the
        // entire group at the deadline, including descendants that ignore SIGTERM.
        const process = await container.exec(options.timeout
          ? ["timeout", "--signal=KILL", `${options.timeout / 1000}s`, "/bin/bash", "-c", timedExecShell, "--", command]
          : commandLine, execOptions(options));
        if (options.id) {
          this.#execs.set(options.id, { process, timed: Boolean(options.timeout) });
          if (this.#cancelled.delete(options.id)) await this.cancelExec(options.id);
        }
        const output = await process.output();
        if (timedOut) throw new Error(`Command timed out after ${options.timeout}ms.`);
        const decoder = new TextDecoder();
        return {
          exitCode: output.exitCode,
          stderr: decoder.decode(output.stderr),
          stdout: decoder.decode(output.stdout),
          success: output.exitCode === 0,
        };
      } finally {
        clearTimeout(timer);
        if (options.id) this.#execs.delete(options.id);
      }
    }

    async deleteFile(path: string) {
      try {
        await (await this.#fileOperations()).remove(path, fileOptions);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      return { success: true };
    }

    async exists(path: string) {
      try {
        await (await this.#fileOperations()).stat(path, fileOptions);
        return { exists: true };
      } catch (error) {
        if (missing(error)) return { exists: false };
        throw error;
      }
    }

    async mkdir(path: string, options: { recursive?: boolean } = {}) {
      await (await this.#fileOperations()).mkdir(path, { ...fileOptions, recursive: options.recursive });
      return { success: true };
    }

    async moveFile(source: string, destination: string) {
      await (await this.#fileOperations()).rename(source, destination, fileOptions);
      return { success: true };
    }

    async readFile(path: string, options: { encoding?: string } = {}) {
      let response: Response;
      try {
        response = await (await this.#fileOperations()).readFile(path, fileOptions);
      } catch (error) {
        if (missing(error)) return { content: "", success: false };
        throw error;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        content: options.encoding === "base64" ? encodeBase64(bytes) : new TextDecoder().decode(bytes),
        success: true,
      };
    }

    async writeFile(path: string, contents: string, options: { encoding?: string } = {}) {
      const bytes = options.encoding === "base64" ? decodeBase64(contents) : new TextEncoder().encode(contents);
      await (await this.#fileOperations()).writeFile(path, bytes, fileOptions);
      return { success: true };
    }

    async startProcess(command: string, options: { cwd?: string; env?: Record<string, string>; stdin?: boolean } = {}) {
      const container = await this.#running();
      const process = await container.exec(["/bin/bash", "-c", command], {
        ...execOptions(options),
        ...(options.stdin ? { stdin: "pipe" as const } : {}),
      });
      const id = crypto.randomUUID();
      const record = new SandboxProcessRecord(process);
      this.#processes.set(id, record);
      // Workers RPC turns these functions into stubs, so the caller keeps talking to this process.
      return {
        id,
        getLogs: async () => record.logs(),
        kill: async (signal?: string) => record.process.kill(signalNumber(signal)),
        ...(options.stdin && process.stdin ? { stdin: process.stdin } : {}),
        waitForExit: async () => ({ exitCode: await record.exited }),
      };
    }

    async streamProcessLogs(processId: string) {
      const record = this.#processes.get(processId);
      if (!record) throw new Error(`Process ${processId} is not running in this Sandbox.`);
      const stream = record.stream();
      // Keep even an already-exited process addressable until this follow-up RPC attaches.
      // The stream and process stubs retain the record after the lookup entry is removed.
      void record.exited.finally(() => this.#processes.delete(processId)).catch(() => undefined);
      return stream;
    }

    #container() {
      const container = this.#ctx.container;
      if (!container) throw new Error("The Sandbox Durable Object has no Container. Add a containers entry for its class in wrangler.json.");
      return container;
    }

    async #running() {
      const container = this.#container();
      if (!container.running) {
        container.start({ enableInternet: true });
        await this.#applyConfiguration();
      }
      return container;
    }

    async #fileOperations() {
      const container = await this.#running();
      this.#files ??= new Files(container);
      return this.#files;
    }

    async #applyConfiguration() {
      if (!this.#configuration) {
        const reading: Promise<CloudflareSandboxConfiguration> = this.#ctx.storage.get<CloudflareSandboxConfiguration>(configurationKey).then(value => value ?? {}).catch((error: unknown) => {
          // A failed storage read lets the next start try again. configure() can store a newer policy meanwhile.
          if (this.#configuration === reading) this.#configuration = undefined;
          throw error;
        });
        this.#configuration = reading;
      }
      const configuration = await this.#configuration;
      await this.#container().setInactivityTimeout(
        configuration.keepAlive ? keepAliveTimeout : parseDuration(configuration.sleepAfter) ?? defaultSleepAfter,
      );
    }
  };
}

function execOptions(options: { cwd?: string; env?: Record<string, string | undefined> }) {
  const env = Object.fromEntries(
    Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/** Same units as @cloudflare/sandbox 0.12 `sleepAfter`: a number of seconds or `"30s"`, `"5m"`, `"1h"`. */
export function parseDuration(value: number | string | undefined) {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value * 1000;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value.trim());
  if (!match) throw new Error(`[vitehub] Invalid Cloudflare sleepAfter ${JSON.stringify(value)}. Use seconds or a value such as "30s", "5m" or "1h".`);
  const units = { h: 3_600_000, m: 60_000, ms: 1, s: 1000 } as const;
  return Number(match[1]) * units[(match[2] ?? "s") as keyof typeof units];
}

function signalNumber(signal: string | undefined) {
  if (!signal) return signals.TERM;
  if (/^\d+$/.test(signal)) return Number(signal);
  const number = signals[signal.toUpperCase().replace(/^SIG/, "")];
  if (number === undefined) throw new Error(`[vitehub] Unsupported signal ${JSON.stringify(signal)}.`);
  return number;
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 8192)
    binary += String.fromCharCode(...value.subarray(offset, offset + 8192));
  return btoa(binary);
}
