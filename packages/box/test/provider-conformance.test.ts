import { posix } from "node:path";

import { describe, expect, it } from "vitest";

import { createCloudflareRuntime, type CloudflareSandboxStub } from "../src/cloudflare.ts";
import { resolveBox, type BoxFileEntry } from "../src/index.ts";
import {
  createVercelRuntime,
  type VercelFileStat,
  type VercelSandboxCommand,
  type VercelSandboxInstance,
} from "../src/vercel.ts";

for (const provider of [cloudflareFixture, vercelFixture]) {
  describe(`${provider.name} Box Adapter`, () => {
    it("satisfies the common Box execution contract", async () => {
      const fixture = provider();
      const box = await resolveBox(
        {
          env: { DECLARED: "base" },
          home: { files: { ".config/vitehub/config.bin": { contents: new Uint8Array([0, 255]) } } },
          runtime: fixture.runtime,
        },
        {},
      );

      expect(box.plan).toMatchObject({
        cache: { state: "disposable" },
        runtime: fixture.name,
        workspace: { state: "disposable", workDir: "." },
      });
      const session = await box.open({ id: "provider-session" });
      expect(session.executionAuthority).toBe(box.plan.executionAuthority);
      expect(Object.isFrozen(box.plan.executionAuthority)).toBe(true);
      expect(Object.isFrozen(box.plan.executionAuthority.filesystem)).toBe(true);
      expect(session.id).toBe("provider-session");
      expect(session.ports?.values).toEqual(fixture.ports);
      expect(await session.files.read("/home/vitehub/.config/vitehub/config.bin")).toEqual(
        new Uint8Array([0, 255]),
      );

      await session.files.mkdir("/workspace/nested", { recursive: true });
      await session.files.write("/workspace/nested/data.bin", new Uint8Array([1, 2, 3]));
      await session.files.write("/workspace/z.bin", new Uint8Array([5]));
      await session.files.mkdir("/workspace/excluded/deep", { recursive: true });
      await session.files.write("/workspace/excluded/deep/private.bin", new Uint8Array([4]));
      expect(await session.files.exists("/workspace/nested/data.bin")).toBe(true);
      expect(await session.files.list("/workspace", { recursive: true })).toContainEqual({
        path: "/workspace/nested/data.bin",
        size: 3,
        type: "file",
      });
      const listsBeforeExclusion = fixture.machine.lists.length;
      const listedWithExclusion = await session.files.list("/workspace", {
        exclude: ["/workspace/excluded"],
        recursive: true,
      });
      expect(listedWithExclusion).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringContaining("excluded") }),
        ]),
      );
      expect(listedWithExclusion.map((entry) => entry.path)).toEqual(
        listedWithExclusion.map((entry) => entry.path).toSorted(),
      );
      expect(fixture.machine.lists.slice(listsBeforeExclusion)).not.toContain(
        "/workspace/excluded",
      );
      const listsBeforeRootExclusion = fixture.machine.lists.length;
      await expect(
        session.files.list("/workspace", { exclude: ["/"], recursive: true }),
      ).resolves.toEqual([]);
      expect(fixture.machine.lists).toHaveLength(listsBeforeRootExclusion);
      await session.files.move?.(
        "/workspace/nested/data.bin",
        "/workspace/nested/moved.bin",
      );
      await session.files.remove("/workspace/nested/moved.bin");
      expect(await session.files.exists("/workspace/nested/moved.bin")).toBe(false);

      await expect(
        session.exec("probe", [], { cwd: "/workspace/nested", env: { INVOCATION: "ready" } }),
      ).resolves.toMatchObject({
        code: 0,
        ok: true,
        stdout: "/workspace/nested|base|ready",
      });
      expect(session.spawn).toBeTypeOf("function");
      const process = await session.spawn!("background");
      expect(fixture.machine.spawnCwd).toBe("/workspace");
      await expect(new Response(process.stdout).text()).resolves.toBe("spawned");
      await expect(process.wait()).resolves.toEqual({ code: 0 });
      await expect(session.ports!.expose(4321)).resolves.toBeInstanceOf(URL);
      if (fixture.name === "vercel") {
        await expect(session.ports!.expose(4321, { protocol: "ws" }))
          .resolves.toEqual(new URL("wss://box-4321.sandbox.vercel.test/"));
      }

      await session.files.write("/home/vitehub/stale", new Uint8Array([1]));
      await session.files.write("/workspace/stale", new Uint8Array([1]));
      await session.close();
      await session.close();
      const reopened = await box.open({ id: "provider-session" });
      await expect(reopened.files.exists("/home/vitehub/stale")).resolves.toBe(false);
      await expect(reopened.files.exists("/workspace/stale")).resolves.toBe(false);
      await reopened.close();
      expect(fixture.machine.stops).toBe(2);
      await expect(session.exec("probe")).rejects.toThrow("Box session is closed");
    });

    it("destroys a failed initialization", async () => {
      const fixture = provider();
      const box = await resolveBox({ runtime: fixture.runtime }, {});

      await expect(
        box.open({
          async initialize() {
            throw new Error("bad initialization");
          },
        }),
      ).rejects.toThrow("bad initialization");
      expect(fixture.machine.stops).toBe(1);
    });

    it("rejects unsupported host cwd and durable Home state during preparation", async () => {
      const fixture = provider();
      await expect(
        resolveBox({ cwd: process.cwd(), runtime: fixture.runtime }, {}),
      ).rejects.toThrow("use Workspace instead");
      await expect(
        resolveBox(
          {
            home: { state: { ".cache": { key: "provider-state" } } },
            runtime: fixture.runtime,
          },
          {},
        ),
      ).rejects.toThrow("does not provide durable Box Home state");
    });
  });
}

function cloudflareFixture() {
  const machine = new VirtualMachine();
  const stub: CloudflareSandboxStub = {
    async deleteFile(path) {
      machine.files.delete(normalize(path));
      return { success: true };
    },
    async destroy() {
      machine.stops++;
    },
    async exec(command, options) {
      if (command.startsWith("rm -rf -- ")) {
        machine.remove(command.slice("rm -rf -- ".length).replace(/^'|'$/g, ""), true);
        return { exitCode: 0, stderr: "", stdout: "", success: true };
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: `${options?.cwd}|${options?.env?.DECLARED}|${options?.env?.INVOCATION}`,
        success: true,
      };
    },
    async exists(path) {
      return { exists: machine.exists(path) };
    },
    async exposePort(port, options) {
      return { url: `https://${options.hostname}:${port}` };
    },
    async listFiles(path, options) {
      return {
        files: machine.list(path, options?.recursive).map((entry) => ({
          absolutePath: entry.path,
          name: posix.basename(entry.path),
          size: entry.size ?? 0,
          type: entry.type,
        })),
      };
    },
    async mkdir(path) {
      machine.directories.add(normalize(path));
      return { success: true };
    },
    async moveFile(source, destination) {
      machine.move(source, destination);
      return { success: true };
    },
    async readFile(path) {
      const contents = machine.files.get(normalize(path));
      return contents
        ? { content: Buffer.from(contents).toString("base64") }
        : { content: "", success: false };
    },
    async startProcess(_command, options) {
      machine.spawnCwd = options?.cwd;
      return {
        async getLogs() {
          return { stderr: "", stdout: "spawned" };
        },
        id: "process",
        async kill() {},
        async waitForExit() {
          return { exitCode: 0 };
        },
      };
    },
    async writeFile(path, contents) {
      machine.write(path, new Uint8Array(Buffer.from(contents, "base64")));
      return { success: true };
    },
  };
  return {
    machine,
    name: "cloudflare",
    ports: [0],
    runtime: createCloudflareRuntime({
      getSandbox: () => stub,
      hostname: "box.example.com",
      namespace: { get: () => stub, idFromName: (name) => name },
    }),
  };
}

function vercelFixture() {
  const machine = new VirtualMachine();
  const instance: VercelSandboxInstance = {
    domain(port) {
      return `https://box-${port}.sandbox.vercel.test`;
    },
    fs: {
      async exists(path) {
        return machine.exists(path);
      },
      async lstat(path) {
        return machine.stat(path);
      },
      async mkdir(path) {
        machine.directories.add(normalize(path));
      },
      async readFile(path) {
        const contents = machine.files.get(normalize(path));
        if (!contents) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return contents;
      },
      async readdir(path) {
        return machine.children(path);
      },
      async rename(source, destination) {
        machine.move(source, destination);
      },
      async rm(path, options) {
        machine.remove(path, options?.recursive);
      },
      async stat(path) {
        return machine.stat(path);
      },
      async writeFile(path, contents) {
        machine.write(path, contents);
      },
    },
    async mkDir(path) {
      machine.directories.add(normalize(path));
    },
    async readFileToBuffer({ path }) {
      return machine.files.get(normalize(path)) ?? null;
    },
    async runCommand(options) {
      if (options.cmd === "sh" && options.args?.[1] === "background") machine.spawnCwd = options.cwd;
      const stdout = options.cmd === "sh" && options.args?.[1] === "background"
        ? "spawned"
        : `${options.cwd}|${options.env?.DECLARED}|${options.env?.INVOCATION}`;
      return command(stdout);
    },
    async stop() {
      machine.stops++;
    },
    async writeFiles(files) {
      for (const file of files) machine.write(file.path, file.content);
    },
  };
  return {
    machine,
    name: "vercel",
    ports: [4321],
    runtime: createVercelRuntime({ create: async () => instance, ports: [4321] }),
  };
}

function command(stdout: string): VercelSandboxCommand {
  return {
    async kill() {},
    async stderr() {
      return "";
    },
    async stdout() {
      return stdout;
    },
    async wait() {
      return { exitCode: 0 };
    },
  };
}

class VirtualMachine {
  readonly directories = new Set(["/", "/home", "/workspace"]);
  readonly files = new Map<string, Uint8Array>();
  readonly lists: string[] = [];
  spawnCwd: string | undefined;
  stops = 0;

  children(path: string) {
    const parent = normalize(path);
    return [...new Set([...this.directories, ...this.files.keys()]
      .filter((entry) => entry !== parent && posix.dirname(entry) === parent)
      .map((entry) => posix.basename(entry)))]
      .sort();
  }

  exists(path: string) {
    const target = normalize(path);
    return this.directories.has(target) || this.files.has(target);
  }

  list(path: string, recursive = false) {
    const root = normalize(path);
    this.lists.push(root);
    const directories: BoxFileEntry[] = [...this.directories]
      .filter((entry) => entry !== root && isChild(entry, root, recursive))
      .map((entry) => ({ path: entry, type: "directory" }));
    const files: BoxFileEntry[] = [...this.files]
      .filter(([entry]) => isChild(entry, root, recursive))
      .map(([entry, value]) => ({ path: entry, size: value.byteLength, type: "file" }));
    return [...directories, ...files].sort((left, right) => left.path.localeCompare(right.path));
  }

  move(source: string, destination: string) {
    const contents = this.files.get(normalize(source));
    if (!contents) throw new Error(`Missing ${source}`);
    this.files.delete(normalize(source));
    this.write(destination, contents);
  }

  remove(path: string, recursive = false) {
    const target = normalize(path);
    this.files.delete(target);
    this.directories.delete(target);
    if (recursive) {
      for (const file of [...this.files.keys()])
        if (file.startsWith(`${target}/`)) this.files.delete(file);
      for (const directory of [...this.directories])
        if (directory.startsWith(`${target}/`)) this.directories.delete(directory);
    }
  }

  stat(path: string): VercelFileStat {
    const target = normalize(path);
    const file = this.files.get(target);
    const directory = this.directories.has(target);
    if (!file && !directory) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return {
      isDirectory: () => directory,
      isFile: () => Boolean(file),
      isSymbolicLink: () => false,
      size: file?.byteLength ?? 0,
    };
  }

  write(path: string, contents: Uint8Array) {
    const target = normalize(path);
    this.directories.add(posix.dirname(target));
    this.files.set(target, new Uint8Array(contents));
  }
}

function isChild(path: string, root: string, recursive: boolean) {
  return path.startsWith(`${root}/`) && (recursive || posix.dirname(path) === root);
}

function normalize(path: string) {
  return posix.normalize(path);
}
