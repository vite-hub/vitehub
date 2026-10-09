import { spawn } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, readdir, rm, rmdir, statfs, writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionMemory } from "../src/internal/session-memory.ts";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(), mkdir: vi.fn(), readFile: vi.fn(), readdir: vi.fn(),
  rmdir: vi.fn(), rm: vi.fn(), statfs: vi.fn(), writeFile: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  chmodSync: vi.fn(), rmSync: vi.fn(), writeFileSync: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));

let events: string;
let localEvents: string;
let peakError: NodeJS.ErrnoException | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  events = "oom 1\noom_kill 1\n";
  localEvents = "oom 1\n";
  peakError = undefined;
  vi.mocked(statfs).mockResolvedValue({ type: 0x63677270 } as Awaited<ReturnType<typeof statfs>>);
  vi.mocked(rm).mockResolvedValue(undefined);
  vi.mocked(readFile).mockImplementation(async (path) => {
    if (String(path).endsWith("cgroup.controllers")) return "memory";
    if (String(path).endsWith("memory.events.local")) return localEvents;
    if (String(path).endsWith("memory.events")) return events;
    if (peakError) throw peakError;
    return "1024";
  });
  vi.mocked(readdir).mockResolvedValue([]);
});

const open = () => createSessionMemory({ cgroupParent: "/delegated", memoryMaxBytes: 1024 });

describe("session memory events", () => {
  it("restores readonly environment names and loader hooks after admission", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const { spawnSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { tmpdir } = await import("node:os");
    const directory = fs.mkdtempSync(`${tmpdir()}/box-launcher-`);
    const group = await open();
    const env = { UID: "1234", EUID: "2345", PPID: "3456", SHELLOPTS: "braceexpand", TOKEN: "secret 'quoted'\nvalue", PATH: "/no-tools", HOME: directory, NODE_OPTIONS: `--require=${directory}/hook.cjs` };
    try {
      fs.writeFileSync(`${directory}/hook.cjs`, `require("node:fs").appendFileSync(${JSON.stringify(`${directory}/hook-pids`)}, process.pid + "\\n");`);
      group.spawn(`exec '${process.execPath}' -e 'console.log(JSON.stringify(process.env))'`, { env });
      const args = [...vi.mocked(spawn).mock.calls[0]![1] as string[]];
      const environmentFile = `${directory}/environment`;
      fs.writeFileSync(environmentFile, vi.mocked(writeFileSync).mock.calls[0]![1]);
      fs.writeFileSync(`${directory}/memory.events.local`, "oom 0\n");
      args[3] = directory;
      args[4] = `${directory}/no-oom-marker`;
      args[5] = environmentFile;
      expect(args.join(" ")).not.toContain(env.TOKEN);
      const result = spawnSync(process.execPath, args, { env: {}, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      // The final command shell sets PPID itself, just as in an unbounded session.
      const { PPID: _ppid, ...expected } = env;
      expect(JSON.parse(result.stdout)).toMatchObject(expected);
      const admittedPid = fs.readFileSync(`${directory}/cgroup.procs`, "utf8");
      expect(admittedPid).toMatch(/^\d+$/);
      // The hook runs once, in the final command, after admission. execve keeps its PID.
      expect(fs.readFileSync(`${directory}/hook-pids`, "utf8")).toBe(`${admittedPid}\n`);
    } finally {
      await group.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["oom 0\n", "oom 1\n", ""])("prepares the environment before admission and fences local events %j", async (events) => {
    const group = await open();
    try {
      group.spawn("echo hello", { env: { TOKEN: "secret" } });
      const args = vi.mocked(spawn).mock.calls[0]![1] as string[];
      const steps: string[] = [];
      const execve = vi.fn(() => steps.push("exec"));
      const exit = vi.fn(() => { throw new Error("launch refused"); });
      const run = () => runInNewContext(args[2]!, {
        require: () => ({
          readFileSync: (path: string) => {
            if (path === args[5]) { steps.push("environment"); return '{"TOKEN":"secret"}'; }
            steps.push("events"); return events;
          },
          writeFileSync: () => { steps.push("join"); },
          existsSync: () => false,
        }),
        process: { argv: [process.execPath, ...args.slice(3)], pid: 123, execve, exit },
      });
      if (events === "oom 0\n") {
        run();
        expect(steps).toEqual(["environment", "join", "events", "exec"]);
        expect(execve).toHaveBeenCalledWith("/bin/sh", ["/bin/sh", "-c", "echo hello"], { TOKEN: "secret" });
      } else {
        expect(run).toThrow("launch refused");
        expect(execve).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledWith(125);
      }
    } finally {
      await group.close();
    }
  });
  it("allows later close listeners to complete when environment-file removal fails", async () => {
    const { ChildProcess } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValueOnce(child);
    const group = await open();
    try {
      const launched = group.spawn("true", { env: { TOKEN: "secret" } });
      const onClose = vi.fn();
      launched.once("close", onClose);
      vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error("cleanup denied"); });
      expect(() => child.emit("close", 0, null)).not.toThrow();
      expect(onClose).toHaveBeenCalledWith(0, null);
      expect(rmSync).toHaveBeenCalledWith(vi.mocked(writeFileSync).mock.calls[0]![0], { force: true });
    } finally {
      await group.close();
    }
  });
  it.each(["write", "chmod", "spawn"])("preserves the %s failure when environment-file removal also fails", async (stage) => {
    const group = await open();
    const originalError = new Error(`${stage} failed`);
    const fail = () => { throw originalError; };
    if (stage === "write") vi.mocked(writeFileSync).mockImplementationOnce(fail);
    else if (stage === "chmod") vi.mocked(chmodSync).mockImplementationOnce(fail);
    else vi.mocked(spawn).mockImplementationOnce(fail);
    vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error("cleanup denied"); });
    try {
      expect(() => group.spawn("true", { env: { TOKEN: "secret" } })).toThrow(originalError);
      expect(rmSync).toHaveBeenCalledWith(vi.mocked(writeFileSync).mock.calls[0]![0], { force: true });
      if (stage !== "spawn") expect(spawn).not.toHaveBeenCalled();
    } finally {
      await group.close();
    }
  });
  it("does not attribute host or ancestor kills to the session budget", async () => {
    events = "oom 1\noom_kill 1\n";
    localEvents = "oom 0\n";
    await expect((await open()).assertHealthy()).resolves.toBeUndefined();
  });
  it("attributes a local OOM even when the killed process was in a descendant", async () => {
    await expect((await open()).assertHealthy()).rejects.toThrow(/limit=1024.*peak=1024.*oom_kill=1/);
  });
  it("keeps the OOM diagnostic on kernels without memory.peak", async () => {
    peakError = Object.assign(new Error("missing"), { code: "ENOENT" });
    await expect((await open()).assertHealthy()).rejects.toThrow(/memory limit exceeded.*peak=unavailable/);
  });
  it("invalidates on local allocation OOM before any kill, without attributing a later external kill", async () => {
    events = "oom 1\noom_kill 0\n";
    const group = await open();
    await expect(group.assertHealthy()).rejects.toThrow(/local allocation OOM recorded.*observed_oom_kill=0/);
    events = "oom 1\noom_kill 1\n";
    await expect(group.assertHealthy()).rejects.toThrow(/local allocation OOM recorded.*Kill count does not identify the OOM cause/);
  });
  it("detects local OOMs on memory_localevents mounts with descendant victims", async () => {
    events = "oom 1\noom_kill 0\n";
    const group = await open();
    await expect(group.assertHealthy()).rejects.toThrow(/local allocation OOM recorded/);
    await expect(group.assertHealthy()).rejects.toThrow(/local allocation OOM recorded/);
  });
  it("rejects concurrent health checks after a local allocation OOM", async () => {
    const group = await open();
    const results = await Promise.allSettled([group.assertHealthy(), group.assertHealthy()]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  });
  it("does not swallow other peak read failures", async () => {
    peakError = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect((await open()).assertHealthy()).rejects.toThrow("denied");
  });
  it("removes nested groups before their parents", async () => {
    const group = await open();
    vi.mocked(readdir).mockResolvedValueOnce([{ name: "child", isDirectory: () => true }] as unknown as Awaited<ReturnType<typeof readdir>>);
    await group.close();
    const paths = vi.mocked(rmdir).mock.calls.map(([path]) => String(path));
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(paths[1] + "/child");
    expect(writeFile).toHaveBeenCalledWith(paths[1] + "/cgroup.kill", "1");
  });
  it("bounds populated-group teardown and permits cleanup retry", async () => {
    const group = await open();
    const read = vi.mocked(readFile).getMockImplementation()!;
    let populated = true;
    vi.mocked(readFile).mockImplementation(async (path, ...args) =>
      String(path).endsWith("cgroup.events") ? `populated ${Number(populated)}\n` : read(path, ...args));
    const clock = vi.spyOn(performance, "now");
    let elapsed = 0;
    clock.mockImplementation(() => elapsed);
    vi.mocked(delay).mockImplementation(async () => { elapsed += 1000; if (elapsed > 10_000) throw new Error("unbounded polling"); });
    try {
      await expect(group.close()).rejects.toThrow(/Timed out.*cgroup.*populated/);
      expect(rmdir).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
      populated = false;
      await group.close();
      expect(rmdir).toHaveBeenCalledTimes(1);
      await group.close();
      expect(rmdir).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });
  it("waits for delayed descendants before removing groups", async () => {
    const group = await open();
    const read = vi.mocked(readFile).getMockImplementation()!;
    let polls = 0;
    vi.mocked(readFile).mockImplementation(async (path, ...args) =>
      String(path).endsWith("cgroup.events") ? `populated ${++polls < 50 ? 1 : 0}\n` : read(path, ...args));
    await group.close();
    expect(polls).toBe(50);
    expect(rmdir).toHaveBeenCalledTimes(1);
  });
  it("starts the launcher with no caller environment and restores it after joining", async () => {
    const group = await open();
    group.spawn("echo hello", { env: { LD_PRELOAD: "/hook.so", ENV: "/hook.sh", PATH: "/untrusted" } });
    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      "--input-type=commonjs", "-e", expect.stringContaining("process.execve"),
      expect.stringMatching(/^\/delegated\/vitehub-box-/),
      expect.stringMatching(/vitehub-box-oom-/),
      expect.stringMatching(/vitehub-box-env-/), "echo hello",
    ], { env: {} });
    expect(access).toHaveBeenCalled();
    expect(mkdir).toHaveBeenCalled();
  });
});
