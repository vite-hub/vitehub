import { afterEach, describe, expect, it, vi } from "vitest";
import { posix } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { createCloudflareRuntime } from "../src/cloudflare.ts";
import { resolveSandbox } from "../src/index.ts";
import {
  createCloudflareSandboxDurableObject,
  parseDuration,
  type CloudflareContainer,
  type CloudflareContainerExecProcess,
  type CloudflareSandboxFiles,
} from "../src/internal/cloudflare-durable-object.ts";

afterEach(() => vi.useRealTimers());

function gnuTimeout() {
  for (const command of ["timeout", "gnutimeout", "gtimeout"]) {
    try {
      if (execFileSync(command, ["--version"], { encoding: "utf8" }).includes("GNU coreutils")) return command;
    } catch {}
  }
  throw new Error("Install GNU coreutils to test the Debian Sandbox image's process-group timeout.");
}

/** Running `sleep <mark>` processes. Zombies do not count. */
function markedProcesses(mark: string) {
  return execFileSync("ps", ["-eo", "pid=,stat=,args="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map(line => line.trim().split(/\s+/))
    .filter(([, status, command, argument]) => command === "sleep" && argument === mark && !status!.startsWith("Z"));
}

class FileError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

class FakeDurableObject {
  constructor(readonly ctx: unknown, readonly env: unknown) {}
}

interface Execution {
  command: string[];
  options: Parameters<CloudflareContainer["exec"]>[1];
  exit(code: number): void;
  stderr: ReadableStreamDefaultController<Uint8Array>;
  stdinText: Promise<string>;
  stdout: ReadableStreamDefaultController<Uint8Array>;
  signals: number[];
}

function fakeContainer() {
  const encoder = new TextEncoder();
  const executions: Execution[] = [];
  const timeouts: number[] = [];
  const container: CloudflareContainer & { destroyed: number; starts: unknown[] } = {
    destroyed: 0,
    running: false,
    starts: [],
    async destroy() {
      this.destroyed++;
      (this as { running: boolean }).running = false;
    },
    async exec(command, options) {
      let stdout!: ReadableStreamDefaultController<Uint8Array>;
      let stderr!: ReadableStreamDefaultController<Uint8Array>;
      let exit!: (code: number) => void;
      const exitCode = new Promise<number>(resolve => exit = resolve);
      const chunks: Uint8Array[] = [];
      let closeInput!: () => void;
      const inputClosed = new Promise<void>(resolve => closeInput = resolve);
      const stdin = options?.stdin === "pipe"
        ? new WritableStream<Uint8Array>({ write: chunk => void chunks.push(chunk), close: closeInput })
        : null;
      const execution: Execution = {
        command,
        exit(code) {
          stdout.close();
          stderr.close();
          exit(code);
        },
        options,
        signals: [],
        get stderr() { return stderr; },
        stdinText: inputClosed.then(() => Buffer.concat(chunks).toString()),
        get stdout() { return stdout; },
      };
      executions.push(execution);
      const process: CloudflareContainerExecProcess = {
        exitCode,
        stderr: new ReadableStream({ start: controller => void (stderr = controller) }),
        stdin,
        stdout: new ReadableStream({ start: controller => void (stdout = controller) }),
        kill: signal => void execution.signals.push(signal ?? 15),
        async output() {
          const read = async (stream: ReadableStream<Uint8Array>) => await new Response(stream).arrayBuffer();
          const [out, err] = [read(process.stdout!), read(process.stderr!)];
          return { exitCode: await exitCode, stderr: await err, stdout: await out };
        },
      };
      if (!command.includes("long-running")) {
        queueMicrotask(() => {
          stdout.enqueue(encoder.encode(`${options?.cwd}|${options?.env?.NAME ?? ""}|${command.join(" ")}`));
          stderr.enqueue(encoder.encode("warning\n"));
          execution.exit(0);
        });
      }
      return process;
    },
    async setInactivityTimeout(duration) {
      if (Number(duration) > 6 * 60 * 60_000) throw new RangeError("Inactivity timeout exceeds six hours");
      timeouts.push(Number(duration));
    },
    start(options) {
      this.starts.push(options);
      (this as { running: boolean }).running = true;
    },
  };
  return { container, executions, timeouts };
}

function fakeFiles() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(["/", "/workspace"]);
  const absolute = (path: string, options?: { cwd?: string }) => {
    if (!posix.isAbsolute(path) && !options?.cwd) throw new TypeError("cwd is required when path is relative");
    return posix.resolve(options?.cwd ?? "/", path);
  };
  class Files implements CloudflareSandboxFiles {
    async mkdir(path: string, options?: { cwd?: string }) {
      directories.add(absolute(path, options));
    }
    async readFile(path: string, options?: { cwd?: string }) {
      const content = files.get(absolute(path, options));
      if (!content) throw new FileError("ENOENT");
      return new Response(content);
    }
    async remove(path: string, options?: { cwd?: string }) {
      if (!files.delete(absolute(path, options))) throw new FileError("ENOENT");
    }
    async rename(source: string, destination: string, options?: { cwd?: string }) {
      source = absolute(source, options);
      destination = absolute(destination, options);
      files.set(destination, files.get(source)!);
      files.delete(source);
    }
    async stat(path: string, options?: { cwd?: string }) {
      path = absolute(path, options);
      if (!files.has(path) && !directories.has(path)) throw new FileError("ENOENT");
      return {};
    }
    async writeFile(path: string, content: Uint8Array, options?: { cwd?: string }) {
      files.set(absolute(path, options), content);
    }
  }
  return { Files, directories, files };
}

/** The `kill` commands that signal a spawned process group: `[signal, group file]`. */
function groupKills(executions: Execution[]) {
  return executions
    .filter(execution => execution.command[2]?.includes("kill -"))
    .map(execution => execution.command.slice(-2));
}

function groupFile(execution: Execution) {
  return execution.command.at(-1);
}

function setup(cloudflare?: Parameters<typeof createCloudflareRuntime>[0]["cloudflare"]) {
  const { container, executions, timeouts } = fakeContainer();
  const { Files, files } = fakeFiles();
  const storage = new Map<string, unknown>();
  const Sandbox = createCloudflareSandboxDurableObject({
    DurableObject: FakeDurableObject,
    Files,
    SandboxFileError: { is: (cause): cause is FileError => cause instanceof FileError },
  });
  const names: string[] = [];
  const objects = new Map<string, InstanceType<typeof Sandbox>>();
  const namespace = {
    get(id: unknown) {
      const name = String(id);
      if (!objects.has(name)) {
        objects.set(name, new Sandbox({
          container,
          id: { name, toString: () => name },
          storage: {
            async get<T>(key: string) { return storage.get(key) as T | undefined; },
            async put(key: string, value: unknown) { storage.set(key, value); },
          },
        }, {}));
      }
      return objects.get(name);
    },
    idFromName(name: string) {
      names.push(name);
      return name;
    },
  };
  const runtime = createCloudflareRuntime({ cloudflare, namespace, sandboxId: "Task-1" });
  return { container, executions, files, names, objects, runtime, storage, timeouts };
}

describe("Cloudflare Sandbox Durable Object", () => {
  it("starts the Container on first use and runs commands, files and cleanup through the default stub", async () => {
    const { container, executions, files, names, runtime, timeouts } = setup({ normalizeId: true, sleepAfter: "30s" });
    const sandbox = await resolveSandbox({ runtime }, {});
    const session = await sandbox.open();

    expect(names).toEqual(["task-1"]);
    expect(container.starts).toEqual([{ enableInternet: true }]);
    expect(timeouts).toEqual([30_000]);

    const result = await session.exec("echo", ["hi"], { env: { NAME: "value" } });
    expect(result.stdout).toContain("/workspace|value|");
    expect(executions.at(-1)!.command.at(-1)).toBe("'echo' 'hi'");
    expect(executions.at(-1)!.options).toMatchObject({ cwd: "/workspace", env: { NAME: "value" } });

    await session.files.write("/workspace/a.txt", new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(files.get("/workspace/a.txt"))).toBe("hello");
    await expect(session.files.read("/workspace/a.txt")).resolves.toEqual(new TextEncoder().encode("hello"));
    await expect(session.files.read("/workspace/missing.txt")).resolves.toBeNull();
    await expect(session.files.exists("/workspace/a.txt")).resolves.toBe(true);
    await expect(session.files.exists("/workspace/missing.txt")).resolves.toBe(false);
    await session.files.move!("/workspace/a.txt", "/workspace/b.txt");
    expect([...files.keys()]).toContain("/workspace/b.txt");
    await session.files.remove("/workspace/b.txt");
    expect(files.has("/workspace/b.txt")).toBe(false);

    await session.close();
    expect(container.destroyed).toBe(1);
  });

  it("reads the idle policy again at the next start after a failed read", async () => {
    const { container, timeouts } = fakeContainer();
    const { Files } = fakeFiles();
    const Sandbox = createCloudflareSandboxDurableObject({
      DurableObject: FakeDurableObject,
      Files,
      SandboxFileError: { is: (cause): cause is FileError => cause instanceof FileError },
    });
    const get = vi.fn()
      .mockRejectedValueOnce(new Error("transient storage failure"))
      .mockResolvedValue({ sleepAfter: "30s" });
    const sandbox = new Sandbox({ container, id: { name: "a", toString: () => "a" }, storage: { get, put: async () => {} } }, {});

    await expect(sandbox.mkdir("/workspace/a")).rejects.toThrow("transient storage failure");
    // The Container went to sleep, so the next call starts it again.
    (container as { running: boolean }).running = false;
    await expect(sandbox.mkdir("/workspace/a")).resolves.toEqual({ success: true });
    expect(timeouts).toEqual([30_000]);
  });

  it("retries a completed deletion after its response is lost", async () => {
    vi.useFakeTimers();
    const { files, objects, runtime } = setup();
    const session = await (await resolveSandbox({ runtime }, {})).open();
    await session.files.write("/workspace/output", new TextEncoder().encode("data"));
    const object = objects.get("Task-1")!;
    const remove = object.deleteFile.bind(object);
    const request = vi.spyOn(object, "deleteFile").mockImplementationOnce(async (path) => {
      await remove(path);
      throw Object.assign(new Error("Network connection lost."), { retryable: true });
    });

    const result = expect(session.files.remove("/workspace/output")).resolves.toBeUndefined();
    await Promise.all([result, vi.runAllTimersAsync()]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(files.has("/workspace/output")).toBe(false);
    await session.close();
  });

  it("resolves relative file operations against /workspace", async () => {
    const { files, runtime, timeouts } = setup();
    const session = await (await resolveSandbox({ runtime }, {})).open();
    expect(timeouts).toEqual([600_000]);
    await session.files.mkdir("input", { recursive: true });
    await expect(session.files.exists("input")).resolves.toBe(true);
    await session.files.write("input/a.txt", new TextEncoder().encode("relative"));
    expect(files.has("/workspace/input/a.txt")).toBe(true);
    await expect(session.files.read("input/a.txt")).resolves.toEqual(new TextEncoder().encode("relative"));
    await expect(session.files.read("input/missing.txt")).resolves.toBeNull();
    await expect(session.files.exists("input/missing.txt")).resolves.toBe(false);
    await session.files.move!("input/a.txt", "/workspace/input/b.txt");
    await session.files.move!("/workspace/input/b.txt", "input/c.txt");
    await session.files.remove("input/c.txt");
    await expect(session.files.exists("input/c.txt")).resolves.toBe(false);
    await session.close();
  });

  it("replays stdout and stderr when a process exits before log attachment", async () => {
    const { objects, runtime } = setup();
    const session = await (await resolveSandbox({ runtime }, {})).open();
    const object = objects.get("Task-1")!;
    const command = await object.startProcess("short-command");
    await expect(command.waitForExit()).resolves.toEqual({ exitCode: 0 });
    const events = await new Response(await object.streamProcessLogs(command.id)).text();
    expect(events).toContain("short-command");
    expect(events).toContain('"type":"stderr"');
    expect(events).toContain('"type":"exit"');

    const process = await session.spawn!("short-command");
    await expect(new Response(process.stdout).text()).resolves.toContain("short-command");
    await expect(new Response(process.stderr).text()).resolves.toBe("warning\n");
    await expect(process.wait()).resolves.toEqual({ code: 0 });
    await session.close();
  });

  it.each(["stdout", "stderr"] as const)("propagates a Container %s read failure through process logs", async (type) => {
    const { container, objects, runtime } = setup();
    const session = await (await resolveSandbox({ runtime }, {})).open();
    const exec = container.exec.bind(container);
    container.exec = async (...args) => ({
      ...await exec(...args),
      [type]: new ReadableStream<Uint8Array>({
        start(controller) { controller.error(new Error(`${type} read failed`)); },
      }),
    });
    try {
      const object = objects.get("Task-1")!;
      const command = await object.startProcess("short-command");
      const events = await new Response(await object.streamProcessLogs(command.id)).text();
      expect(events).toContain(`"data":"${type} read failed","type":"error"`);
      expect(events).not.toContain('"type":"exit"');

      const process = await session.spawn!("short-command");
      await Promise.all([process.stdout, process.stderr].map(async (stream) => {
        await expect(new Response(stream).text()).rejects.toThrow(`${type} read failed`);
      }));
      await expect(process.wait()).resolves.toEqual({ code: 0 });
    } finally {
      await session.close();
    }
  });

  it.skipIf(process.platform === "win32").each([
    "sleep 600 & wait",
    "sleep 600 & exit 0",
    "sleep 600 >&2 & exit 0",
    "bash -c 'trap \"\" TERM; sleep 600' & exit 0",
  ])("times out descendants and drains output for %s", async (command) => {
    const timeout = gnuTimeout();
    const { container, objects, runtime } = setup();
    const session = await (await resolveSandbox({ runtime }, {})).open();
    const children: ReturnType<typeof spawn>[] = [];
    container.exec = async (command, options) => {
      const child = spawn(command[0] === "timeout" ? timeout : command[0]!, command.slice(1), { detached: true });
      children.push(child);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout!.on("data", chunk => stdout.push(chunk));
      child.stderr!.on("data", chunk => stderr.push(chunk));
      const exitCode = new Promise<number>((resolve, reject) => {
        child.on("exit", code => resolve(code ?? 137));
        child.on("error", reject);
      });
      const closed = new Promise<void>(resolve => child.on("close", () => resolve()));
      options?.signal?.addEventListener("abort", () => child.kill());
      return {
        exitCode,
        stderr: null,
        stdin: null,
        stdout: null,
        kill: signal => { child.kill(signal); },
        async output() {
          await closed;
          return { exitCode: await exitCode, stderr: new Uint8Array(Buffer.concat(stderr)).buffer, stdout: new Uint8Array(Buffer.concat(stdout)).buffer };
        },
      };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // GNU timeout reserves these codes too; an early command exit must retain its status.
      for (const exitCode of [124, 137]) {
        await expect(objects.get("Task-1")!.exec(`exit ${exitCode}`, { timeout: 10_000 }))
          .resolves.toMatchObject({ exitCode, success: false });
      }
      await expect(objects.get("Task-1")!.exec("printf output; printf warning >&2; exit 4", { timeout: 10_000 }))
        .resolves.toEqual({ exitCode: 4, stderr: "warning", stdout: "output", success: false });
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Descendants kept output open")), 2_000);
      });
      await expect(Promise.race([
        objects.get("Task-1")!.exec(command, { timeout: 50 }),
        deadline,
      ])).rejects.toThrow("Command timed out after 50ms.");
      // Output closing alone does not prove that every descendant stopped.
      const processes = execFileSync("ps", ["-eo", "pgid=,stat="], { encoding: "utf8" });
      const group = children.at(-1)!.pid;
      const running = processes.trim().split("\n").filter((line) => {
        const [pgid, status] = line.trim().split(/\s+/);
        return Number(pgid) === group && !status!.startsWith("Z");
      });
      expect(running).toEqual([]);
    } finally {
      clearTimeout(timer);
      for (const child of children) {
        try { process.kill(-child.pid!, "SIGKILL"); } catch {}
      }
      await session.close();
    }
  });

  it.skipIf(process.platform !== "linux").each([
    ["SIGTERM", "sleep $MARK & wait"],
    ["SIGKILL", "sleep $MARK & wait"],
    ["SIGKILL", "bash -c 'trap \"\" TERM; sleep $MARK' & sleep $MARK"],
  ])("sends %s to every process of a spawned command: %s", async (signal, template) => {
    const mark = `6${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
    const { container, objects, runtime } = setup();
    const session = await (await resolveSandbox({ runtime }, {})).open();
    const children: ReturnType<typeof spawn>[] = [];
    container.exec = async (command, options) => {
      const child = spawn(command[0]!, command.slice(1), { cwd: "/", stdio: ["pipe", "pipe", "pipe"] });
      children.push(child);
      const exitCode = new Promise<number>((resolve, reject) => {
        child.on("exit", (code, signal) => resolve(code ?? (signal === "SIGKILL" ? 137 : 143)));
        child.on("error", reject);
      });
      const stream = (readable: NodeJS.ReadableStream) => new ReadableStream<Uint8Array>({
        start(controller) {
          readable.on("data", chunk => controller.enqueue(new Uint8Array(chunk)));
          readable.on("end", () => controller.close());
        },
      });
      return {
        exitCode,
        stderr: options?.stderr === "ignore" ? null : stream(child.stderr!),
        stdin: null,
        stdout: options?.stdout === "ignore" ? null : stream(child.stdout!),
        kill: signal => { child.kill(signal); },
        async output() { throw new Error("not used"); },
      };
    };
    try {
      const child = await objects.get("Task-1")!.startProcess(`echo started; ${template.replaceAll("$MARK", mark)}`);
      await vi.waitFor(() => expect(markedProcesses(mark).length).toBeGreaterThanOrEqual(template.includes("trap") ? 2 : 1));

      await child.kill(signal);

      await expect(child.waitForExit()).resolves.toEqual({ exitCode: signal === "SIGKILL" ? 137 : 143 });
      await vi.waitFor(() => expect(markedProcesses(mark)).toEqual([]));
      // The wrapper's job notice ("Killed ...") stays out of the command output.
      await expect(child.getLogs()).resolves.toEqual({ stderr: "", stdout: "started\n" });
      const groupFile = children[0]!.spawnargs.at(-1)!;
      expect(groupFile).toMatch(/^\/tmp\/vitehub-process-.+\.pgid$/);
      expect(existsSync(groupFile)).toBe(false);
    } finally {
      for (const [pid] of markedProcesses(mark)) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
      await session.close();
    }
  });

  it("streams spawned output live, forwards stdin and reports the exit code", async () => {
    const { executions, runtime } = setup();
    const sandbox = await resolveSandbox({ runtime }, {});
    const session = await sandbox.open();
    const process = await session.spawn!("long-running", [], { stdin: true });
    const execution = executions.at(-1)!;
    expect(execution.options).toMatchObject({ stdin: "pipe" });

    const encoder = new TextEncoder();
    const reader = process.stdout.getReader();
    execution.stdout.enqueue(encoder.encode("first\n"));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");

    const writer = process.stdin!.getWriter();
    await writer.write(encoder.encode("input"));
    await writer.close();
    await expect(execution.stdinText).resolves.toBe("input");

    execution.stdout.enqueue(encoder.encode("second\n"));
    execution.stderr.enqueue(encoder.encode("warning\n"));
    const stderr = new Response(process.stderr).text();
    execution.exit(4);

    expect(new TextDecoder().decode((await reader.read()).value)).toBe("second\n");
    expect((await reader.read()).done).toBe(true);
    await expect(stderr).resolves.toBe("warning\n");
    await expect(process.wait()).resolves.toEqual({ code: 4 });
    await session.close();
  });

  it("does not open stdin unless the caller asks, and maps signal names", async () => {
    const { executions, runtime, timeouts } = setup({ keepAlive: true });
    const sandbox = await resolveSandbox({ runtime }, {});
    const session = await sandbox.open();
    const process = await session.spawn!("long-running");
    const execution = executions.at(-1)!;

    expect(timeouts).toEqual([21_600_000]);
    expect(execution.options?.stdin).toBeUndefined();
    expect(process.stdin).toBeUndefined();
    await process.kill("SIGINT");
    expect(groupKills(executions)).toEqual([["2", groupFile(execution)]]);
    execution.exit(130);
    await session.close();
  });

  it("stops only the aborted command when exec times out or is cancelled", async () => {
    const { container, executions, runtime } = setup();
    const session = await (await resolveSandbox({ runtime }, {})).open();
    const controller = new AbortController();

    const running = () => executions.filter(execution => execution.command.at(-1) === "long-running");

    const cancelled = session.exec("long-running", [], { signal: controller.signal });
    await vi.waitFor(() => expect(running()).toHaveLength(1));
    controller.abort(new Error("cancel exec"));
    await expect(cancelled).rejects.toThrow("cancel exec");
    // GNU timeout treats SIGALRM as its deadline and kills the command's process group.
    await vi.waitFor(() => expect(running()[0]!.signals).toEqual([14]));
    running()[0]!.exit(137);

    await expect(session.exec("long-running", [], { timeout: 50 })).rejects.toThrow();
    await vi.waitFor(() => expect(running()[1]!.signals).toEqual([14]));
    running()[1]!.exit(137);

    expect(container.destroyed).toBe(0);
    expect(container.running).toBe(true);
    await expect(session.exec("echo", ["still open"])).resolves.toMatchObject({ code: 0 });
    await session.close();
    expect(container.destroyed).toBe(1);
  });

  it("cancels an exec whose cancellation arrives before the command starts", async () => {
    const { executions, objects, runtime } = setup();
    await (await resolveSandbox({ runtime }, {})).open();
    const object = objects.get("Task-1")!;

    const before = executions.length;
    await object.cancelExec("early");
    await expect(object.exec("long-running", { id: "early", timeout: 60_000 })).rejects.toThrow("cancelled before it started");
    expect(executions).toHaveLength(before);
  });

  it("kills a spawned process when its signal aborts or its timeout elapses", async () => {
    const { container, executions, runtime } = setup();
    const session = await (await resolveSandbox({ runtime }, {})).open();
    const controller = new AbortController();
    const reason = new Error("cancel spawn");

    const cancelled = await session.spawn!("long-running", [], { signal: controller.signal });
    const first = executions.at(-1)!;
    controller.abort(reason);
    await vi.waitFor(() => expect(groupKills(executions)).toEqual([["9", groupFile(first)]]));
    first.exit(137);
    await expect(cancelled.wait()).rejects.toBe(reason);

    const timed = await session.spawn!("long-running", [], { timeout: 20 });
    const second = executions.at(-1)!;
    await vi.waitFor(() => expect(groupKills(executions).at(-1)).toEqual(["9", groupFile(second)]));
    second.exit(137);
    await expect(timed.wait()).rejects.toMatchObject({ name: "TimeoutError" });

    expect(container.destroyed).toBe(0);
    await session.close();
  });

  it("reads sleepAfter in 0.x units", () => {
    expect(parseDuration(90)).toBe(90_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(() => parseDuration("soon")).toThrow("Invalid Cloudflare sleepAfter");
  });
});
