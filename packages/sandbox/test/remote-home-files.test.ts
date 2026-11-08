import { describe, expect, it, vi } from "vitest";

import type { SandboxRuntimeInput } from "../src/index.ts";
import { openRemoteSandbox } from "../src/internal/remote.ts";
import type { RuntimeSession } from "../src/internal/session.ts";

const authority = {
  credentials: "unknown",
  environment: "selected",
  filesystem: { access: "read-write", scope: "sandbox" },
  isolation: "container",
  network: "unknown",
  processes: "arbitrary",
} as const;

function fixture(count = 20) {
  const files = new Map<string, Uint8Array>();
  const events: string[] = [];
  const content = new Uint8Array([0, 0, 255]);
  const runtime: RuntimeSession = {
    defaultWorkingDirectory: "/workspace",
    id: "remote-home-files",
    async destroy() { events.push("destroy"); },
    async existsFile() { return false; },
    async listFiles() { return []; },
    async makeDirectory({ path }) { events.push(`mkdir:${path}`); },
    async readBinaryFile({ path }) { return files.get(path) ?? null; },
    async removeFile() {},
    async run() {
      expect(files.size).toBe(count);
      events.push("requirements");
      return { exitCode: 0, stderr: "", stdout: "" };
    },
    async stop() { events.push("stop"); },
    async writeBinaryFile({ content, path }) { files.set(path, Uint8Array.from(content)); },
  };
  const input = {
    identity: "fixture",
    plan: {
      env: {},
      files: Object.fromEntries(Array.from({ length: count }, (_, index) => [`skills/file-${index}`, {
        async resolve() {
          events.push(`resolve:${index}`);
          content[0] = index;
          return content;
        },
      }])),
      state: [],
    },
    requirements: [{ args: [], command: "node", name: "node" }],
  } satisfies SandboxRuntimeInput;
  const initialize = vi.fn(async () => {
    expect(files.size).toBe(count);
    expect(events.at(-1)).toBe("requirements");
  });
  const open = (signal?: AbortSignal) => openRemoteSandbox(input, runtime, {
    executionAuthority: authority,
    initialize,
    runtime: "fixture",
    signal,
  }, {});
  return { events, files, initialize, input, open, runtime };
}

describe("remote Sandbox Home files", () => {
  it("overlaps independent uploads within a bounded batch before checking requirements", async () => {
    const { events, files, open, runtime } = fixture();
    const write = runtime.writeBinaryFile;
    let active = 0;
    let peak = 0;
    runtime.writeBinaryFile = async options => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>(done => setImmediate(done));
      await write(options);
      active--;
    };
    const session = await open();
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect(active).toBe(0);
    expect([...files.values()]).toEqual(Array.from({ length: 20 }, (_, index) => new Uint8Array([index, 0, 255])));
    expect(events.filter(event => event.startsWith("resolve:"))).toEqual(Array.from({ length: 20 }, (_, index) => `resolve:${index}`));
    expect(session.executionAuthority).toEqual(authority);
    await session.close();
  });

  it("creates each shared Home directory once per boot", async () => {
    const { events, open } = fixture();
    const session = await open();
    expect(events.filter(event => event === "mkdir:/home/vitehub/skills")).toHaveLength(1);
    await session.close();
  });

  it("waits for active uploads before cleaning up a failed boot", async () => {
    const { events, initialize, open, runtime } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failed = new Error("upload failed");
    let active = 0;
    runtime.writeBinaryFile = async ({ path }) => {
      active++;
      try {
        if (path.endsWith("file-0")) throw failed;
        entered.resolve();
        await release.promise;
      } finally { active--; }
    };
    const outcome = open().catch((error: unknown) => error);
    expect(await Promise.race([entered.promise.then(() => true), outcome.then(() => false)])).toBe(true);
    await new Promise<void>(done => setImmediate(done));
    expect(events).not.toContain("destroy");
    release.resolve();
    expect(await outcome).toBe(failed);
    expect(active).toBe(0);
    expect(events.at(-1)).toBe("destroy");
    expect(initialize).not.toHaveBeenCalled();
    expect(events).not.toContain("requirements");
    expect(events.filter(event => event.startsWith("resolve:"))).toHaveLength(8);
  });

  it("settles uploads and preserves the caller's abort reason before cleanup", async () => {
    const { events, initialize, open, runtime } = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error("cancel Sandbox startup");
    let active = 0;
    runtime.writeBinaryFile = async () => {
      active++;
      entered.resolve();
      try { await release.promise; } finally { active--; }
    };
    const outcome = open(controller.signal).catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    await new Promise<void>(done => setImmediate(done));
    expect(events).not.toContain("destroy");
    release.resolve();
    expect(await outcome).toBe(reason);
    expect(active).toBe(0);
    expect(events.at(-1)).toBe("destroy");
    expect(initialize).not.toHaveBeenCalled();
    expect(events).not.toContain("requirements");
    expect(events.filter(event => event.startsWith("resolve:"))).toHaveLength(8);
  });

  it("does not start a batch when one of its file resolvers fails", async () => {
    const { events, files, initialize, input, open } = fixture();
    const reason = new Error("secret resolver failed");
    input.plan.files["skills/file-2"] = { async resolve() { throw reason; } };
    await expect(open()).rejects.toBe(reason);
    expect(files.size).toBe(0);
    expect(events.at(-1)).toBe("destroy");
    expect(initialize).not.toHaveBeenCalled();
    expect(events).not.toContain("resolve:3");
    expect(events).not.toContain("requirements");
  });
});
