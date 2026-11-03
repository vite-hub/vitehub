import { describe, expect, it } from "vitest";
import { posix } from "node:path";

import { createCloudflareRuntime } from "../src/cloudflare.ts";
import { resolveSandbox } from "../src/index.ts";
import {
  createCloudflareSandboxDurableObject,
  parseDuration,
  type CloudflareContainer,
  type CloudflareContainerExecProcess,
  type CloudflareSandboxFiles,
} from "../src/internal/cloudflare-durable-object.ts";

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
      if (command[2] !== "long-running") {
        queueMicrotask(() => {
          stdout.enqueue(encoder.encode(`${options?.cwd}|${options?.env?.NAME ?? ""}|${command.join(" ")}`));
          execution.exit(0);
        });
      }
      return process;
    },
    async setInactivityTimeout(duration) {
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
  class Files implements CloudflareSandboxFiles {
    async mkdir(path: string) {
      directories.add(posix.normalize(path));
    }
    async readFile(path: string) {
      const content = files.get(path);
      if (!content) throw new FileError("ENOENT");
      return new Response(content);
    }
    async remove(path: string) {
      if (!files.delete(path)) throw new FileError("ENOENT");
    }
    async rename(source: string, destination: string) {
      files.set(destination, files.get(source)!);
      files.delete(source);
    }
    async stat(path: string) {
      if (!files.has(path) && !directories.has(path)) throw new FileError("ENOENT");
      return {};
    }
    async writeFile(path: string, content: Uint8Array) {
      files.set(path, content);
    }
  }
  return { Files, directories, files };
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
  return { container, executions, files, names, runtime, storage, timeouts };
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
    expect(result.stdout).toBe("/workspace|value|/bin/bash -c 'echo' 'hi'");
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
    const { executions, runtime } = setup({ keepAlive: true });
    const sandbox = await resolveSandbox({ runtime }, {});
    const session = await sandbox.open();
    const process = await session.spawn!("long-running");
    const execution = executions.at(-1)!;

    expect(execution.options?.stdin).toBeUndefined();
    expect(process.stdin).toBeUndefined();
    await process.kill("SIGINT");
    expect(execution.signals).toEqual([2]);
    execution.exit(130);
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
