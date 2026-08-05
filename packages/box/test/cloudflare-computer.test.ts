import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareComputerRuntime,
  type CloudflareComputerFileStat,
  type CloudflareComputerWorkspace,
} from "../src/cloudflare-computer.ts";
import { resolveBox } from "../src/index.ts";

describe("Cloudflare Computer Box runtime", () => {
  it("adapts a durable Computer workspace without owning its lifecycle", async () => {
    const files = new Map<string, Uint8Array>();
    const directories = new Set(["/"]);
    const dispose = vi.fn();
    let execution: { command: string; options: Record<string, unknown> } | undefined;
    let disposedExecution = 0;
    const workspace: CloudflareComputerWorkspace = {
      fs: {
        async lstat(path) {
          const contents = files.get(path);
          if (contents) return stat("file", contents.byteLength);
          if (directories.has(path)) return stat("directory", 0);
          throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
        },
        async mkdir(path) {
          directories.add(path);
        },
        async readFile(path) {
          const contents = files.get(path);
          if (!contents) throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
          return new ReadableStream({
            start(controller) {
              controller.enqueue(contents);
              controller.close();
            },
          });
        },
        async readdir(path) {
          const prefix = path === "/" ? "/" : `${path}/`;
          const names = new Set<string>();
          for (const value of [...directories, ...files.keys()]) {
            if (!value.startsWith(prefix)) continue;
            const name = value.slice(prefix.length).split("/")[0];
            if (name) names.add(name);
          }
          return [...names].map((name) => {
            const child = `${prefix}${name}`;
            return {
              isDirectory: directories.has(child),
              isFile: files.has(child),
              isSymbolicLink: false,
              name,
            };
          });
        },
        async rm(path, options) {
          files.delete(path);
          directories.delete(path);
          if (options?.recursive) {
            for (const value of files.keys()) if (value.startsWith(`${path}/`)) files.delete(value);
            for (const value of directories) if (value.startsWith(`${path}/`)) directories.delete(value);
          }
        },
        async writeFile(path, contents) {
          files.set(path, contents);
        },
      },
      runtime: {
        async exec(command, options) {
          execution = { command, options: options ?? {} };
          return {
            id: "execution",
            async kill() {},
            async result() {
              return { exitCode: 0, stderr: "", stdout: "ready" };
            },
            [Symbol.dispose]() {
              disposedExecution++;
            },
          };
        },
      },
      [Symbol.dispose]: dispose,
    };
    const namespace = {
      get: vi.fn(() => ({ workspace: true })),
      idFromName: vi.fn((name: string) => `id:${name}`),
    };
    const getWorkspace = vi.fn(async () => workspace);
    const box = await resolveBox({
      env: { TOKEN: "selected" },
      home: { files: { ".config/vitehub.bin": { contents: new Uint8Array([0, 255]) } } },
      runtime: createCloudflareComputerRuntime({
        backend: "container-shell",
        getWorkspace,
        namespace,
      }),
    }, {});

    expect(box.plan).toMatchObject({
      runtime: "cloudflare-computer",
      workspace: { state: "disposable" },
    });
    expect(box.plan.executionAuthority).toMatchObject({
      filesystem: { access: "read-write", scope: "sandbox" },
      isolation: "unknown",
      processes: "unknown",
    });

    const session = await box.open({ id: "agent-1" });
    files.set("/retained.bin", new Uint8Array([1]));
    expect(namespace.idFromName).toHaveBeenCalledWith("agent-1");
    expect(await session.files.read("/home/vitehub/.config/vitehub.bin"))
      .toEqual(new Uint8Array([0, 255]));
    await expect(session.exec("echo", ["hello"], { env: { EXTRA: "yes" }, timeout: 1_000 }))
      .resolves.toMatchObject({ code: 0, stdout: "ready" });
    expect(execution).toMatchObject({
      command: "'echo' 'hello'",
      options: {
        backend: "container-shell",
        cwd: "/workspace",
        encoding: "utf8",
        env: { EXTRA: "yes", HOME: "/home/vitehub", TOKEN: "selected" },
        timeoutMs: 1_000,
      },
    });
    expect(disposedExecution).toBe(1);

    await session.close();
    await session.close();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(directories.has("/home/vitehub")).toBe(false);
    expect(directories.has("/workspace")).toBe(false);
    expect(files.has("/home/vitehub/.config/vitehub.bin")).toBe(false);
    expect(files.has("/retained.bin")).toBe(true);
  });

  it("selects the tagged runtime through the Box root", async () => {
    const workspace = {} as CloudflareComputerWorkspace;
    const box = await resolveBox({
      runtime: {
        getWorkspace: async () => workspace,
        kind: "cloudflare-computer",
        namespace: { get: () => ({}), idFromName: name => name },
      },
    }, {});

    expect(box.plan.runtime).toBe("cloudflare-computer");
  });

  it("kills pending executions before disposing the workspace", async () => {
    let rejectExecution!: (reason: unknown) => void;
    const executionResult = new Promise<{ exitCode: number; stderr: string; stdout: string }>((_resolve, reject) => {
      rejectExecution = reject;
    });
    let markResultStarted!: () => void;
    const resultStarted = new Promise<void>((resolve) => {
      markResultStarted = resolve;
    });
    const kill = vi.fn(async () => rejectExecution(new Error("killed")));
    const disposeExecution = vi.fn();
    const disposeWorkspace = vi.fn();
    const workspace = {
      fs: emptyFilesystem(),
      runtime: {
        async exec() {
          return {
            id: "pending",
            kill,
            result() {
              markResultStarted();
              return executionResult;
            },
            [Symbol.dispose]: disposeExecution,
          };
        },
      },
      [Symbol.dispose]: disposeWorkspace,
    } satisfies CloudflareComputerWorkspace;
    const box = await resolveBox({
      runtime: createCloudflareComputerRuntime({
        getWorkspace: async () => workspace,
        namespace: { get: () => ({}), idFromName: name => name },
      }),
    }, {});
    const session = await box.open();
    const pending = session.exec("sleep", ["60"]);
    await resultStarted;

    await session.close();

    await expect(pending).rejects.toThrow("killed");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(disposeExecution).toHaveBeenCalledTimes(1);
    expect(disposeWorkspace).toHaveBeenCalledTimes(1);
  });

  it("waits for opening executions before closing the workspace", async () => {
    let resolveExecution!: (execution: Awaited<ReturnType<CloudflareComputerWorkspace["runtime"]["exec"]>>) => void;
    let finishKill!: () => void;
    const kill = vi.fn(() => new Promise<void>(resolve => {
      finishKill = resolve;
    }));
    const disposeExecution = vi.fn();
    const disposeWorkspace = vi.fn();
    const workspace = {
      fs: emptyFilesystem(),
      runtime: {
        exec: () => new Promise<Awaited<ReturnType<CloudflareComputerWorkspace["runtime"]["exec"]>>>(resolve => {
          resolveExecution = resolve;
        }),
      },
      [Symbol.dispose]: disposeWorkspace,
    } satisfies CloudflareComputerWorkspace;
    const box = await resolveBox({
      runtime: createCloudflareComputerRuntime({
        getWorkspace: async () => workspace,
        namespace: { get: () => ({}), idFromName: name => name },
      }),
    }, {});
    const session = await box.open();
    const pending = session.exec("sleep", ["60"]);
    const closing = session.close();

    await expect(Promise.race([closing.then(() => "closed"), Promise.resolve("pending")])).resolves.toBe("pending");
    resolveExecution({
      id: "late",
      kill,
      async result() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      [Symbol.dispose]: disposeExecution,
    });

    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith("SIGKILL"));
    expect(disposeWorkspace).not.toHaveBeenCalled();
    finishKill();
    await closing;
    await expect(pending).rejects.toThrow("closed");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(disposeExecution).toHaveBeenCalledTimes(1);
    expect(disposeWorkspace).toHaveBeenCalledTimes(1);
  });

  it("cancels execution-handle RPCs by their assigned ID during close", async () => {
    let rejectExecution!: (reason: unknown) => void;
    const exec = vi.fn((...[_command, options]: Parameters<CloudflareComputerWorkspace["runtime"]["exec"]>) => new Promise<never>((_resolve, reject) => {
      rejectExecution = reject;
      expect(options?.id).toMatch(/^vitehub-/);
    }));
    const killExec = vi.fn(async (id: string) => {
      rejectExecution(new Error(`killed ${id}`));
    });
    const disposeWorkspace = vi.fn();
    const workspace = {
      fs: emptyFilesystem(),
      runtime: { exec, killExec },
      [Symbol.dispose]: disposeWorkspace,
    } satisfies CloudflareComputerWorkspace;
    const box = await resolveBox({
      runtime: createCloudflareComputerRuntime({
        getWorkspace: async () => workspace,
        namespace: { get: () => ({}), idFromName: name => name },
      }),
    }, {});
    const session = await box.open();
    const pending = session.exec("sleep", ["60"]);

    await session.close();

    await expect(pending).rejects.toThrow("killed vitehub-");
    expect(killExec).toHaveBeenCalledWith(expect.stringMatching(/^vitehub-/), { signal: "SIGKILL" });
    expect(disposeWorkspace).toHaveBeenCalledTimes(1);
  });

  it("normalizes filesystem options and listing order", async () => {
    const mkdir = vi.fn(async () => {});
    const rm = vi.fn(async () => {});
    const workspace = {
      fs: {
        ...emptyFilesystem(),
        async lstat(path: string) {
          return stat(path.endsWith("/directory") ? "directory" : "file", 0);
        },
        mkdir,
        async readdir() {
          return [
            { isDirectory: false, isFile: true, isSymbolicLink: false, name: "z.txt" },
            { isDirectory: true, isFile: false, isSymbolicLink: false, name: "directory" },
            { isDirectory: false, isFile: true, isSymbolicLink: false, name: "a.txt" },
          ];
        },
        rm,
      },
      runtime: { async exec() { throw new Error("unexpected exec"); } },
    } satisfies CloudflareComputerWorkspace;
    const box = await resolveBox({
      runtime: createCloudflareComputerRuntime({
        getWorkspace: async () => workspace,
        namespace: { get: () => ({}), idFromName: name => name },
      }),
    }, {});
    const session = await box.open();
    mkdir.mockClear();
    rm.mockClear();

    await session.files.mkdir("/workspace/new", { recursive: false });
    await session.files.remove("/workspace/old", { recursive: false });
    expect(mkdir).toHaveBeenCalledWith("/workspace/new", undefined);
    expect(rm).toHaveBeenCalledWith("/workspace/old", { force: true });
    expect((await session.files.list("/workspace")).map(entry => entry.path)).toEqual([
      "/workspace/a.txt",
      "/workspace/directory",
      "/workspace/z.txt",
    ]);
    await session.close();
  });

  it("rejects an abort while Computer is still opening the execution handle", async () => {
    let resolveExecution!: (execution: Awaited<ReturnType<CloudflareComputerWorkspace["runtime"]["exec"]>>) => void;
    let finishKill!: () => void;
    const kill = vi.fn(() => new Promise<void>(resolve => {
      finishKill = resolve;
    }));
    const disposeExecution = vi.fn();
    const disposeWorkspace = vi.fn();
    const workspace = {
      fs: emptyFilesystem(),
      runtime: {
        exec: () => new Promise<Awaited<ReturnType<CloudflareComputerWorkspace["runtime"]["exec"]>>>(resolve => {
          resolveExecution = resolve;
        }),
      },
      [Symbol.dispose]: disposeWorkspace,
    } satisfies CloudflareComputerWorkspace;
    const box = await resolveBox({
      runtime: createCloudflareComputerRuntime({
        getWorkspace: async () => workspace,
        namespace: { get: () => ({}), idFromName: name => name },
      }),
    }, {});
    const session = await box.open();
    const controller = new AbortController();
    const pending = session.exec("sleep", ["60"], { signal: controller.signal });
    controller.abort(new Error("cancelled"));

    await expect(pending).rejects.toThrow("cancelled");
    const closing = session.close();
    resolveExecution({
      id: "late",
      kill,
      async result() {
        return { exitCode: 0, stderr: "", stdout: "" };
      },
      [Symbol.dispose]: disposeExecution,
    });
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith("SIGKILL"));
    expect(disposeWorkspace).not.toHaveBeenCalled();
    finishKill();
    await closing;
    expect(disposeExecution).toHaveBeenCalledTimes(1);
    expect(disposeWorkspace).toHaveBeenCalledTimes(1);
  });

  it("kills an execution when abort wins as its handle opens", async () => {
    const controller = new AbortController();
    const kill = vi.fn(async () => {});
    const workspace = {
      fs: emptyFilesystem(),
      runtime: {
        async exec() {
          queueMicrotask(() => controller.abort(new Error("cancelled")));
          return {
            id: "opening",
            kill,
            async result() {
              return { exitCode: 0, stderr: "", stdout: "" };
            },
          };
        },
      },
    } satisfies CloudflareComputerWorkspace;
    const box = await resolveBox({
      runtime: createCloudflareComputerRuntime({
        getWorkspace: async () => workspace,
        namespace: { get: () => ({}), idFromName: name => name },
      }),
    }, {});
    const session = await box.open();

    await expect(session.exec("sleep", ["60"], { signal: controller.signal })).rejects.toThrow("cancelled");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    await session.close();
  });
});

function emptyFilesystem(): CloudflareComputerWorkspace["fs"] {
  return {
    async lstat() {
      return stat("directory", 0);
    },
    async mkdir() {},
    async readFile() {
      return new ReadableStream();
    },
    async readdir() {
      return [];
    },
    async rm() {},
    async writeFile() {},
  };
}

function stat(type: "directory" | "file", size: number): CloudflareComputerFileStat {
  return {
    isDirectory: type === "directory",
    isFile: type === "file",
    isSymbolicLink: false,
    size,
  };
}
