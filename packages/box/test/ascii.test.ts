import { posix } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createAsciiRuntime } from "../src/ascii.ts";
import { resolveBox, type BoxFileEntry } from "../src/index.ts";
import type { RuntimeSession } from "../src/internal/session.ts";

describe("ASCII Box runtime", () => {
  it("selects ASCII without loading its optional SDK during preparation", async () => {
    const direct = await resolveBox({ runtime: "ascii" }, {});
    const configured = await resolveBox(
      {
        runtime: { apiKey: "test", kind: "ascii", ttlSeconds: 7200 },
      },
      {},
    );

    expect(direct.plan.runtime).toBe("ascii");
    expect(configured.plan.runtime).toBe("ascii");
    expect(configured.plan.executionAuthority).toMatchObject({
      filesystem: { access: "read-write", scope: "sandbox" },
      processes: "arbitrary",
    });
  });

  it("materializes Home, environment, requirements, and closes provider resources once", async () => {
    const fixture = asciiFixture();
    const box = await resolveBox(
      {
        env: { DECLARED: "ready" },
        home: {
          files: {
            ".config/vitehub.bin": { contents: new Uint8Array([0, 255]) },
          },
        },
        requires: ["node"],
        runtime: fixture.runtime,
      },
      {},
    );
    const session = await box.open();

    expect(session.id).toBe("bx_test");
    expect(session.spawn).toBeTypeOf("function");
    expect(await session.files.read("/home/user/.vitehub/home/.config/vitehub.bin")).toEqual(
      new Uint8Array([0, 255]),
    );
    await expect(session.exec("env-probe")).resolves.toMatchObject({
      code: 0,
      stdout: "/home/user/.vitehub/home|ready",
    });

    const process = await session.spawn!("sleep", ["3600"]);
    await process.kill("TERM");
    await expect(process.wait()).resolves.toEqual({ code: 137 });
    await session.close();
    await session.close();

    expect(fixture.control.created).toEqual({
      noEnv: true,
      ttlSeconds: 7200,
    });
    expect(fixture.control.authorizedKey).toBe("ssh-ed25519 test");
    expect(fixture.control.removes).toBe(1);
    expect(fixture.machine.stops).toBe(1);
  });

  it("preserves a caller-supplied session ID", async () => {
    const fixture = asciiFixture();
    const box = await resolveBox({ runtime: fixture.runtime }, {});
    const session = await box.open({ id: "invocation-session" });

    expect(session.id).toBe("invocation-session");
    await session.close();
  });

  it("uses a fresh cleanup signal when provisioning is cancelled", async () => {
    const fixture = asciiFixture();
    const controller = new AbortController();
    fixture.control.waitForReady = async (signal) =>
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const box = await resolveBox({ runtime: fixture.runtime }, {});

    const opened = box.open({ signal: controller.signal });
    await vi.waitFor(() => expect(fixture.control.gets).toBe(1));
    controller.abort(new Error("cancel ASCII provisioning"));

    await expect(opened).rejects.toThrow("cancel ASCII provisioning");
    expect(fixture.control.removes).toBe(1);
    expect(fixture.control.cleanupSignal?.aborted).toBe(false);
  });

  it("bounds a stalled provisioning request without a caller signal", async () => {
    const fixture = asciiFixture({ provisioningTimeoutMs: 5 });
    fixture.control.waitForReady = async (signal) =>
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const box = await resolveBox({ runtime: fixture.runtime }, {});

    const failure = await box.open().catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(fixture.control.gets).toBeGreaterThanOrEqual(1);
    expect(fixture.control.removes).toBe(1);
  });

  it("finishes create before honoring cancellation so the new Box can be deleted", async () => {
    const fixture = asciiFixture();
    let finishCreate!: () => void;
    fixture.control.waitForCreate = new Promise((resolve) => {
      finishCreate = resolve;
    });
    const controller = new AbortController();
    const box = await resolveBox({ runtime: fixture.runtime }, {});

    const opened = box.open({ signal: controller.signal });
    await vi.waitFor(() => expect(fixture.control.creates).toBe(1));
    controller.abort(new Error("cancel ASCII creation"));
    expect(fixture.control.removes).toBe(0);
    const rejected = expect(opened).rejects.toThrow("cancel ASCII creation");
    finishCreate();

    await rejected;
    expect(fixture.control.createSignal).not.toBe(controller.signal);
    expect(fixture.control.createSignal?.aborted).toBe(false);
    expect(fixture.control.removes).toBe(1);
  });

  it("attempts provider deletion after SSH teardown times out", async () => {
    const fixture = asciiFixture();
    fixture.machine.stopNever = true;
    const box = await resolveBox({ runtime: fixture.runtime }, {});
    const session = await box.open();

    vi.useFakeTimers();
    try {
      const closing = session.close().catch((error) => error);
      await vi.advanceTimersByTimeAsync(10_000);
      const failure = await closing;
      expect(flattenMessages(failure)).toContain(
        "[vitehub] ASCII Box bx_test SSH teardown timed out.",
      );
      expect(fixture.machine.stops).toBe(1);
      expect(fixture.control.removes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves initialization and verified-deletion failures", async () => {
    const fixture = asciiFixture();
    fixture.control.removeError = new Error("DELETE unavailable");
    fixture.control.stopError = new Error("stop unavailable");
    const box = await resolveBox({ runtime: fixture.runtime }, {});

    let failure: unknown;
    try {
      await box.open({
        async initialize() {
          throw new Error("initialization failed");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(flattenMessages(failure)).toEqual(
      expect.arrayContaining([
        "initialization failed",
        expect.stringContaining("could not be verified as deleted"),
      ]),
    );
    expect(fixture.control.stops).toBeGreaterThan(0);
    expect(fixture.machine.stops).toBe(1);
  });

  it("rejects incomplete host-key bootstrap data", async () => {
    const fixture = asciiFixture();
    fixture.control.hostKey = "ssh-ed25519 bm90LWFuLXNzaC1rZXk=";
    const box = await resolveBox({ runtime: fixture.runtime }, {});

    await expect(box.open()).rejects.toThrow("invalid SSH host public key");
    expect(fixture.control.removes).toBe(1);
  });
});

function asciiFixture(options: { provisioningTimeoutMs?: number } = {}) {
  const machine = new FakeAsciiMachine();
  const control = {
    archiveAfterStop: true,
    authorizedKey: "",
    cleanupSignal: undefined as AbortSignal | undefined,
    creates: 0,
    createSignal: undefined as AbortSignal | undefined,
    created: undefined as { noEnv: true; ttlSeconds: number } | undefined,
    gets: 0,
    hostKey: hostPublicKey(),
    removeError: undefined as Error | undefined,
    removed: false,
    removes: 0,
    state: "ready",
    stopError: undefined as Error | undefined,
    stops: 0,
    waitForReady: undefined as undefined | ((signal: AbortSignal | undefined) => Promise<never>),
    waitForCreate: undefined as Promise<void> | undefined,
  };
  const client = {
    async command() {
      return {
        exitCode: 0,
        stderr: "",
        stdout: control.hostKey,
        timedOut: false,
      };
    },
    async create(
      input: { createBoxRequest: { noEnv: true; ttlSeconds: number } },
      init?: RequestInit,
    ) {
      control.creates++;
      control.createSignal = init?.signal ?? undefined;
      control.created = input.createBoxRequest;
      await control.waitForCreate;
      return { box: { id: "bx_test", ip: "192.0.2.1", state: "provisioning" } };
    },
    async get(_input: unknown, init?: RequestInit) {
      control.gets++;
      if (control.removed) throw Object.assign(new Error("missing"), { response: { status: 404 } });
      if (control.waitForReady) await control.waitForReady(init?.signal ?? undefined);
      return {
        box: {
          id: "bx_test",
          ip: "192.0.2.1",
          state: control.state,
        },
      };
    },
    async remove(_input: unknown, init?: RequestInit) {
      control.removes++;
      control.cleanupSignal = init?.signal ?? undefined;
      if (control.removeError) throw control.removeError;
      control.removed = true;
    },
    async sshKey(input: { sshKeyRequest: { key: string } }) {
      control.authorizedKey = input.sshKeyRequest.key;
    },
    async stop() {
      control.stops++;
      if (control.stopError) throw control.stopError;
      if (control.archiveAfterStop) control.state = "archived";
    },
  };
  return {
    control,
    machine,
    runtime: createAsciiRuntime(
      { apiKey: "test" },
      {
        async createClient() {
          return client;
        },
        async createIdentity() {
          return { privateKey: "private", publicKey: "ssh-ed25519 test" };
        },
        async openSsh() {
          return machine.session;
        },
        provisioningTimeoutMs: options.provisioningTimeoutMs,
      },
    ),
  };
}

class FakeAsciiMachine {
  readonly directories = new Set(["/home/user"]);
  readonly files = new Map<string, Uint8Array>();
  stops = 0;
  stopError: Error | undefined;
  stopNever = false;

  readonly session: RuntimeSession = {
    defaultWorkingDirectory: "/home/user/.vitehub/workspace",
    id: "transport",
    existsFile: async ({ path }) => this.directories.has(path) || this.files.has(path),
    listFiles: async ({ path, recursive }) => this.list(path, recursive),
    makeDirectory: async ({ path }) => {
      this.directories.add(path);
    },
    moveFile: async ({ destination, source }) => {
      const contents = this.files.get(source);
      if (!contents) throw new Error(`missing ${source}`);
      this.files.delete(source);
      this.files.set(destination, contents);
    },
    readBinaryFile: async ({ path }) => this.files.get(path) ?? null,
    removeFile: async ({ path, recursive }) => {
      this.files.delete(path);
      this.directories.delete(path);
      if (recursive) {
        for (const value of [...this.files.keys()])
          if (value.startsWith(`${path}/`)) this.files.delete(value);
        for (const value of [...this.directories])
          if (value.startsWith(`${path}/`)) this.directories.delete(value);
      }
    },
    run: async ({ command, env }) => {
      if (command === "exit 37") return result(37);
      if (command === "printf vitehub-ascii") return result(0, "vitehub-ascii");
      if (command === "env-probe") return result(0, `${env?.HOME}|${env?.DECLARED}`);
      return result(0);
    },
    spawn: async () => {
      let killed = false;
      return {
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        async kill() {
          killed = true;
        },
        async wait() {
          return { exitCode: killed ? 137 : 0 };
        },
      };
    },
    stop: async () => {
      this.stops++;
      if (this.stopNever) await new Promise(() => {});
      if (this.stopError) throw this.stopError;
    },
    writeBinaryFile: async ({ content, path }) => {
      this.files.set(path, new Uint8Array(content));
    },
  };

  private list(path: string, recursive: boolean | undefined): BoxFileEntry[] {
    const entries: BoxFileEntry[] = [];
    for (const directory of this.directories) {
      if (directory !== path && isChild(path, directory, recursive))
        entries.push({ path: directory, type: "directory" });
    }
    for (const [file, contents] of this.files) {
      if (isChild(path, file, recursive))
        entries.push({ path: file, size: contents.length, type: "file" });
    }
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }
}

function isChild(parent: string, child: string, recursive: boolean | undefined) {
  if (!child.startsWith(`${parent}/`)) return false;
  return recursive || posix.dirname(child) === parent;
}

function hostPublicKey() {
  const type = Buffer.from("ssh-ed25519");
  const key = Buffer.alloc(32, 7);
  const blob = Buffer.alloc(4 + type.length + 4 + key.length);
  blob.writeUInt32BE(type.length, 0);
  type.copy(blob, 4);
  blob.writeUInt32BE(key.length, 4 + type.length);
  key.copy(blob, 8 + type.length);
  return `ssh-ed25519 ${blob.toString("base64")} ascii-host`;
}

function result(exitCode: number, stdout = "") {
  return { exitCode, stderr: "", stdout };
}

function flattenMessages(error: unknown): string[] {
  if (error instanceof AggregateError)
    return [error.message, ...error.errors.flatMap(flattenMessages)];
  return [error instanceof Error ? error.message : String(error)];
}
