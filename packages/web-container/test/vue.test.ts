// @vitest-environment happy-dom

import { flushPromises, mount } from "@vue/test-utils";
import type { WebContainerStatus } from "../src/index.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit = vi.fn(); } }));

// A fake container: the tests control when each process exits.
const fake = vi.hoisted(() => {
  const state = {
    disk: new Map<string, string>(),
    directories: new Set<string>(),
    autoReady: true,
    failNext: false,
    ready: undefined as ((url: string) => void) | undefined,
    serverListener: undefined as ((server: { url: string, port: number }) => void) | undefined,
    exits: [] as { command: unknown, env?: Record<string, string>, resolve: (code: number) => void }[],
    output: [] as ReadableStreamDefaultController<string>[],
    mountFiles: undefined as Record<string, string> | undefined,
    releaseBoot: undefined as (() => void) | undefined,
    statusListener: undefined as ((status: WebContainerStatus) => void) | undefined,
  };
  return state;
});

vi.mock("../src/index.ts", () => ({
  checkWebContainerSupport: () => ({ supported: true }),
  async bootWebContainer(options: { files: Record<string, string>, onStatus: (status: WebContainerStatus) => void }) {
    fake.statusListener = options.onStatus;
    fake.mountFiles = { ...options.files };
    for (const [path, contents] of Object.entries(options.files)) {
      fake.disk.set(path, contents);
      const parts = path.split("/");
      while (parts.pop() && parts.length) fake.directories.add(parts.join("/"));
    }
    options.onStatus({ stage: "booting", steps: [{ stage: "booting", startedAt: 0 }] });
    await new Promise<void>((resolve) => { fake.releaseBoot = resolve; });
    let ready: (value: { url: string, port: number }) => void = () => {};
    const readyPromise = new Promise<{ url: string, port: number }>((resolve) => { ready = resolve; });
    let previewUrl: string | undefined;
    fake.ready = (url) => {
      previewUrl = url;
      const server = { port: 3000, url };
      ready(server);
      fake.serverListener?.(server);
    };
    return {
      status: { stage: "mounting", steps: [] },
      preview: { ready: readyPromise, get url() { return previewUrl; } },
      fs: {
        mkdir: async (path: string) => { fake.directories.add(path); },
        rm: async (path: string) => {
          if ([...fake.disk.keys(), ...fake.directories].some(child => child.startsWith(`${path}/`))) throw new Error("ENOTEMPTY");
          fake.disk.delete(path);
          fake.directories.delete(path);
        },
        writeFile: async (path: string, contents: string) => {
          if (fake.directories.has(path)) throw new Error("EISDIR");
          fake.disk.set(path, contents);
        },
      },
      on: (event: string, listener: never) => {
        if (event === "server-ready") fake.serverListener = listener;
        else fake.statusListener = listener;
        return () => {};
      },
      async run(command: unknown, options: { env?: Record<string, string> } = {}) {
        if (fake.failNext) { fake.failNext = false; throw new Error("spawn failed"); }
        let resolve: (code: number) => void = () => {};
        const exit = new Promise<number>((done) => { resolve = done; });
        fake.exits.push({ command, env: options.env, resolve });
        if (command !== "install" && fake.autoReady) fake.ready?.("https://preview.example");
        return { exit, kill: () => resolve(143), output: new ReadableStream<string>({ start(controller) { fake.output.push(controller); controller.enqueue(`$ ${String(command)}\n`); } }) };
      },
      teardown: () => {},
    };
  },
}));

const { useWebContainer } = await import("../src/vue.ts");

function mountWorkspace(options: Parameters<typeof useWebContainer>[0]) {
  let workspace!: ReturnType<typeof useWebContainer>;
  const wrapper = mount(defineComponent({
    setup() {
      workspace = useWebContainer(options);
      return () => h("div");
    },
  }));
  return { workspace, wrapper };
}

beforeEach(() => {
  fake.disk.clear();
  fake.directories.clear();
  fake.autoReady = true;
  fake.failNext = false;
  fake.ready = undefined;
  fake.serverListener = undefined;
  fake.statusListener = undefined;
  fake.exits.length = 0;
  fake.output.length = 0;
  fake.mountFiles = undefined;
  fake.releaseBoot = undefined;
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useWebContainer", () => {
  it("writes edits made before mount when the mount ends, and tracks modified files", async () => {
    const { workspace, wrapper } = mountWorkspace({ files: { "a.txt": "a", "b.txt": "b" } });
    await flushPromises();
    expect(workspace.status.value).toBe("booting");

    await workspace.setFiles({ "a.txt": "edited", "new/c.txt": "c" });
    expect(fake.mountFiles).toEqual({ "a.txt": "a", "b.txt": "b" });
    expect(workspace.modified.value).toEqual(["a.txt", "new/c.txt"]);

    fake.releaseBoot?.();
    await flushPromises();
    expect(fake.disk.get("a.txt")).toBe("edited");
    expect(fake.disk.get("new/c.txt")).toBe("c");
    expect(fake.exits.map(run => run.command)).toEqual(["install"]);

    await workspace.setFiles({ "a.txt": "a" }, { mode: "replace" });
    expect([...fake.disk.keys()]).toEqual(["a.txt"]);
    await workspace.reset();
    expect(Object.fromEntries(fake.disk)).toEqual({ "a.txt": "a", "b.txt": "b" });
    expect(workspace.modified.value).toEqual([]);
    wrapper.unmount();
  });

  it("reports an install failure with its exit code, and retries the install", async () => {
    const { workspace, wrapper } = mountWorkspace({ env: () => ({ OPENAI_API_KEY: "sk-test" }), files: { "a.txt": "a" } });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    fake.exits[0]?.resolve(1);
    await flushPromises();
    expect(workspace.failure.value).toMatchObject({ exitCode: 1, kind: "install" });
    expect(workspace.status.value).toBe("error");

    void workspace.install();
    await flushPromises();
    expect(workspace.failure.value).toBeUndefined();
    fake.exits[1]?.resolve(0);
    await flushPromises();
    expect(fake.exits.map(run => run.command)).toEqual(["install", "install", "dev"]);
    expect(fake.exits[2]?.env).toEqual({ OPENAI_API_KEY: "sk-test" });
    expect(workspace.previewUrl.value).toBe("https://preview.example");
    wrapper.unmount();
  });

  it("reports a stopped dev server and restarts it", async () => {
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    expect(fake.exits.map(run => run.command)).toEqual(["dev"]);

    fake.exits[0]?.resolve(1);
    await flushPromises();
    expect(workspace.failure.value).toMatchObject({ exitCode: 1, kind: "server" });
    expect(workspace.previewUrl.value).toBeUndefined();

    await workspace.restart();
    await flushPromises();
    expect(workspace.failure.value).toBeUndefined();
    expect(fake.exits.map(run => run.command)).toEqual(["dev", "dev"]);

    // A restart that the app asks for is not a failure.
    await workspace.restart();
    await flushPromises();
    expect(workspace.failure.value).toBeUndefined();
    wrapper.unmount();
  });

  it.each([
    { install: false, start: false },
    { install: "install", start: false },
    { install: false, start: ["node", "server.js"] },
  ] as const)("completes start mode $start with install $install", async ({ install, start }) => {
    const { workspace, wrapper } = mountWorkspace({ files: {}, install, start });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    if (install !== false) {
      fake.exits[0]?.resolve(0);
      await flushPromises();
    }
    expect(workspace.status.value).toBe("ready");
    wrapper.unmount();
  });

  it("keeps a restarted preview empty until the new server is ready", async () => {
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    expect(workspace.previewUrl.value).toBe("https://preview.example");
    fake.autoReady = false;
    await workspace.restart();
    await flushPromises();
    expect(workspace.previewUrl.value).toBeUndefined();
    expect(workspace.status.value).toBe("starting");
    fake.ready?.("https://replacement.example");
    expect(workspace.previewUrl.value).toBe("https://replacement.example");
    expect(workspace.status.value).toBe("ready");
    wrapper.unmount();
  });

  it("ignores other server ports before readiness and after restart", async () => {
    fake.autoReady = false;
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false, port: 3000 });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();

    fake.serverListener?.({ port: 4321, url: "https://worker.example" });
    expect(workspace.previewUrl.value).toBeUndefined();
    expect(workspace.status.value).toBe("starting");
    fake.ready?.("https://preview.example");
    expect(workspace.previewUrl.value).toBe("https://preview.example");
    fake.serverListener?.({ port: 4321, url: "https://worker.example" });
    expect(workspace.previewUrl.value).toBe("https://preview.example");

    await workspace.restart();
    fake.serverListener?.({ port: 4321, url: "https://worker.example" });
    expect(workspace.previewUrl.value).toBeUndefined();
    expect(workspace.status.value).toBe("starting");
    fake.ready?.("https://replacement.example");
    expect(workspace.previewUrl.value).toBe("https://replacement.example");
    expect(workspace.status.value).toBe("ready");
    wrapper.unmount();
  });

  it("serializes overlapping install and restart recovery", async () => {
    const { workspace, wrapper } = mountWorkspace({ files: {} });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    fake.exits[0]?.resolve(0);
    await flushPromises();
    const installing = workspace.install();
    const restarting = workspace.restart();
    await flushPromises();
    expect(fake.exits.map(run => run.command)).toEqual(["install", "dev", "install"]);
    fake.exits[2]?.resolve(0);
    await Promise.all([installing, restarting]);
    expect(fake.exits.map(run => run.command)).toEqual(["install", "dev", "install", "dev", "dev"]);
    wrapper.unmount();
  });

  it.each(["install", "server"] as const)("retries a %s spawn failure on the existing container", async (kind) => {
    fake.failNext = true;
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: kind === "server" ? false : "install" });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    expect(workspace.failure.value).toMatchObject({ kind, error: { message: "spawn failed" } });
    const retry = kind === "install" ? workspace.install() : workspace.restart();
    await flushPromises();
    if (kind === "install") fake.exits[0]?.resolve(0);
    await retry;
    expect(workspace.failure.value).toBeUndefined();
    expect(workspace.status.value).toBe("ready");
    wrapper.unmount();
  });

  it("replaces nested directories with a file and resets it", async () => {
    const { workspace, wrapper } = mountWorkspace({ files: { "src/nested/main.ts": "original" }, install: false, start: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    await workspace.setFiles({ src: "replacement" }, { mode: "replace" });
    expect(Object.fromEntries(fake.disk)).toEqual({ src: "replacement" });
    await workspace.reset();
    expect(Object.fromEntries(fake.disk)).toEqual({ "src/nested/main.ts": "original" });
    wrapper.unmount();
  });

  it("removes root files named after inherited object properties on replacement", async () => {
    const files = { constructor: "source", toString: "text" };
    const { workspace, wrapper } = mountWorkspace({ files, install: false, start: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    await workspace.setFiles({ "new.txt": "new" }, { mode: "replace" });
    expect(Object.fromEntries(fake.disk)).toEqual({ "new.txt": "new" });
    await workspace.reset();
    expect(Object.fromEntries(fake.disk)).toEqual(files);
    wrapper.unmount();
  });

  it.each(["starting", "ready"])("keeps asynchronous errors visible from %s until recovery", async (stage) => {
    fake.autoReady = stage === "ready";
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    expect(workspace.status.value).toBe(stage);

    const error = new Error("Container disconnected");
    fake.statusListener?.({ error, stage: "error", steps: [] });
    expect(workspace.failure.value).toEqual({ error, kind: "server" });
    expect(workspace.previewUrl.value).toBeUndefined();
    fake.ready?.("https://late.example");
    expect(workspace.status.value).toBe("error");
    expect(workspace.previewUrl.value).toBeUndefined();

    fake.autoReady = true;
    await workspace.restart();
    expect(workspace.failure.value).toBeUndefined();
    expect(workspace.status.value).toBe("ready");
    wrapper.unmount();
  });

  it("does not start a server after an asynchronous install error", async () => {
    const { workspace, wrapper } = mountWorkspace({ files: {} });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    const error = new Error("Container disconnected during install");
    fake.statusListener?.({ error, stage: "error", steps: [] });
    fake.exits[0]?.resolve(0);
    await flushPromises();
    expect(workspace.failure.value).toEqual({ error, kind: "install" });
    expect(workspace.status.value).toBe("error");
    expect(fake.exits.map(run => run.command)).toEqual(["install"]);

    const retry = workspace.install();
    await flushPromises();
    fake.exits[1]?.resolve(0);
    await retry;
    expect(workspace.failure.value).toBeUndefined();
    expect(workspace.status.value).toBe("ready");
    wrapper.unmount();
  });

  it("bounds retained output for large chunks and long-running processes", async () => {
    vi.useFakeTimers();
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    const output = fake.output[0]!;
    output.enqueue("x".repeat(70_000));
    output.enqueue("newest\n");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.logs.value.join("")).toBe(`${"x".repeat(65_536 - 7)}newest\n`);

    for (let index = 0; index < 1100; index++) output.enqueue(`${index}\n`);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.logs.value).toHaveLength(1000);
    expect(workspace.logs.value.join("")).toBe(Array.from({ length: 1000 }, (_, index) => `${index + 100}\n`).join(""));
    wrapper.unmount();
  });

  it("keeps the offset that lets a terminal write only new output across character and chunk retention rollover", async () => {
    vi.useFakeTimers();
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    const output = fake.output[0]!;
    // A terminal remembers where its last write ended, as `WorkspaceTerminal` of @vite-hub/ui does.
    let cursor = 0;
    function unwritten() {
      const logs = workspace.logs.value;
      const start = logs.offset ?? 0;
      const text = logs.join("");
      const fresh = text.slice(Math.max(0, cursor - start));
      cursor = start + text.length;
      return fresh;
    }
    output.enqueue("x".repeat(65_520));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    unwritten();

    for (const chunk of ["first rollover\n", "second rollover\n"]) {
      output.enqueue(chunk);
      await flushPromises();
      await vi.advanceTimersByTimeAsync(50);
      expect(unwritten()).toBe(chunk);
    }

    for (let index = 0; index < 1005; index++) output.enqueue(`${index}\n`);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.logs.value).toHaveLength(1000);
    unwritten();
    output.enqueue("after chunk rollover\n");
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    expect(unwritten()).toBe("after chunk rollover\n");
    wrapper.unmount();
  });

  it("collects process output in order", async () => {
    vi.useFakeTimers();
    const { workspace, wrapper } = mountWorkspace({ files: {}, install: false });
    await flushPromises();
    fake.releaseBoot?.();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(50);
    expect(workspace.logs.value.join("")).toBe("$ dev\n");
    wrapper.unmount();
  });
});
