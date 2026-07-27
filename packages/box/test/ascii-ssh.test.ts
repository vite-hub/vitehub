import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  openAsciiSshSession,
  parseAsciiFileList,
  type AsciiSshOptions,
} from "../src/internal/ascii-ssh.ts";

describe("ASCII SSH transport", () => {
  it("pins the provider-reported host key and closes a rejected connection", async () => {
    const server = new FakeSshServer();
    const options = {
      ...sshOptions(server),
      hostKeys: [new Uint8Array([9, 9, 9])],
    };

    await expect(openSession(server, options)).rejects.toThrow("host key");
    expect(server.client.destroyed).toBe(true);
  });

  it("closes an authenticated connection when SFTP negotiation fails", async () => {
    const server = new FakeSshServer();
    server.sftpError = new Error("SFTP unavailable");

    await expect(openSession(server)).rejects.toThrow("SFTP unavailable");
    expect(server.client.destroyed).toBe(true);
  });

  it("closes an authenticated connection when SFTP negotiation is cancelled", async () => {
    const server = new FakeSshServer();
    server.holdSftpOpen = true;
    const controller = new AbortController();
    const opening = openSession(server, {
      ...sshOptions(server),
      abortSignal: controller.signal,
    });

    await vi.waitFor(() => expect(server.sftpOpens).toBe(1));
    controller.abort(new Error("cancel SFTP negotiation"));

    await expect(opening).rejects.toThrow("cancel SFTP negotiation");
    expect(server.client.destroyed).toBe(true);
  });

  it("closes a connection when SSH authentication is cancelled", async () => {
    const server = new FakeSshServer();
    server.holdConnect = true;
    const controller = new AbortController();
    const opening = openSession(server, {
      ...sshOptions(server),
      abortSignal: controller.signal,
    });

    await vi.waitFor(() => expect(server.connects).toBe(1));
    controller.abort(new Error("cancel SSH authentication"));

    await expect(opening).rejects.toThrow("cancel SSH authentication");
    expect(server.client.destroyed).toBe(true);
  });

  it("preserves tabs in listed file paths", async () => {
    expect(parseAsciiFileList("f\t7\t/home/user/with\ttab\0")).toEqual([
      { path: "/home/user/with\ttab", size: 7, type: "file" },
    ]);
  });

  it("fails closed when the authenticated SSH client reports a transport error", async () => {
    const server = new FakeSshServer();
    const session = await openSession(server);

    server.client.emit("error", new Error("SSH connection lost"));

    await vi.waitFor(() => expect(server.boxDestroys).toBe(1));
    await expect(session.existsFile({ path: "/home/user/.vitehub/workspace" })).rejects.toThrow(
      "SSH connection lost",
    );
    await expect(session.stop()).rejects.toThrow();
  });

  it("fails closed when cancellation interrupts an in-flight SFTP operation", async () => {
    const server = new FakeSshServer();
    server.holdSftpRead = true;
    const session = await openSession(server);
    const controller = new AbortController();
    const reading = session.readBinaryFile({
      abortSignal: controller.signal,
      path: "/home/user/proof.bin",
    });

    expect(server.sftpReads).toBe(1);
    controller.abort(new Error("cancel SFTP read"));

    await expect(reading).rejects.toThrow("cancel SFTP read");
    await vi.waitFor(() => expect(server.boxDestroys).toBe(1));
    expect(server.client.destroyed).toBe(true);
    await expect(
      session.writeBinaryFile({
        content: new Uint8Array(),
        path: "/home/user/another.bin",
      }),
    ).rejects.toThrow("cancel SFTP read");
    await expect(session.stop()).rejects.toThrow();
  });

  it("kills a process when cancellation arrives during launch observation", async () => {
    const server = new FakeSshServer();
    server.holdObservation = true;
    const session = await openSession(server);
    const controller = new AbortController();
    const spawned = session.spawn!({
      abortSignal: controller.signal,
      command: "sleep 3600",
    });

    await vi.waitFor(() => expect(server.observation).toBeDefined());
    controller.abort(new Error("cancel launch"));
    server.releaseObservation();

    await expect(spawned).rejects.toThrow("cancel launch");
    await vi.waitFor(() => expect(server.killSignals).toEqual(["KILL"]));
    await session.stop();
  });

  it("destroys the Box when cancellation races the SSH exec callback", async () => {
    const server = new FakeSshServer();
    server.holdExec = true;
    const session = await openSession(server);
    const controller = new AbortController();
    const spawned = session.spawn!({
      abortSignal: controller.signal,
      command: "sleep 3600",
    });

    controller.abort(new Error("cancel SSH launch"));

    await expect(spawned).rejects.toThrow("cancel SSH launch");
    expect(server.boxDestroys).toBe(1);
    await session.stop();
  });

  it("destroys the Box when launch observation times out", async () => {
    const server = new FakeSshServer();
    server.holdObservation = true;
    const session = await openSession(server);

    vi.useFakeTimers();
    try {
      const spawned = session.spawn!({ command: "sleep 3600" }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(10_000);

      const failure = await spawned;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("control command timed out");
      expect(server.boxDestroys).toBe(1);
      await expect(session.stop()).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps requested signals and proves the systemd cgroup is empty", async () => {
    const server = new FakeSshServer();
    const session = await openSession(server);
    const process = await session.spawn!({ command: "sleep 3600" });

    await process.kill("TERM");

    await expect(process.wait()).resolves.toEqual({ exitCode: 143 });
    expect(server.killSignals).toEqual(["TERM"]);
    expect(server.commands.some((command) => command.includes("cgroup.procs"))).toBe(true);
    await session.stop();
  });

  it("keeps environment values out of process arguments", async () => {
    const server = new FakeSshServer();
    const session = await openSession(server);
    const process = await session.spawn!({
      command: "sleep 3600",
      env: { GH_TOKEN: "secret-value" },
    });

    expect(server.commands.join("\n")).not.toContain("secret-value");
    expect(server.writtenFiles).toEqual([
      expect.objectContaining({
        contents: expect.stringContaining("secret-value"),
        mode: 0o700,
      }),
    ]);
    await process.kill();
    await session.stop();
  });

  it("rejects invalid environment names before launching", async () => {
    const server = new FakeSshServer();
    const session = await openSession(server);

    await expect(
      session.spawn!({ command: "true", env: { "SAFE; touch /tmp/injected; #": "value" } }),
    ).rejects.toThrow("Invalid Box environment variable");
    expect(server.commands.join("\n")).not.toContain("touch /tmp/injected");
    expect(server.boxDestroys).toBe(1);
  });

  it("accepts a transient unit that systemd already collected", async () => {
    const server = new FakeSshServer();
    server.unitCollected = true;
    const session = await openSession(server);
    const process = await session.spawn!({ command: "exit 0" });

    await process.kill();

    expect(server.boxDestroys).toBe(0);
    await session.stop();
  });

  it("streams multiple stdout and stderr chunks and supports consumer cancellation", async () => {
    const server = new FakeSshServer();
    server.processStderr = ["error-one", "error-two"];
    server.processStdout = ["output-one", "output-two", "output-three"];
    const session = await openSession(server);
    const process = await session.spawn!({ command: "sleep 3600" });
    const stdout = process.stdout.getReader();
    const stderr = process.stderr.getReader();

    await expect(stdout.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array(Buffer.from("output-one")),
    });
    await expect(stdout.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array(Buffer.from("output-two")),
    });
    await expect(stderr.read()).resolves.toMatchObject({
      done: false,
      value: new Uint8Array(Buffer.from("error-one")),
    });
    await stdout.cancel();
    await stderr.cancel();
    await process.kill();
    await session.stop();
  });

  it("destroys the Box when process termination cannot be verified", async () => {
    const server = new FakeSshServer();
    server.verificationExitCode = 1;
    const session = await openSession(server);
    const process = await session.spawn!({ command: "sleep 3600" });

    await expect(process.kill()).rejects.toThrow("could not verify");
    expect(server.boxDestroys).toBe(1);
    await session.stop();
  });
});

async function openSession(server: FakeSshServer, options: AsciiSshOptions = sshOptions(server)) {
  return await openAsciiSshSession(options, async () => server.module as never);
}

function sshOptions(server: FakeSshServer): AsciiSshOptions {
  return {
    destroyBox: async () => {
      server.boxDestroys++;
    },
    host: "192.0.2.1",
    hostKeys: [server.hostKey],
    identity: {
      privateKey: "private",
      publicKey: "ssh-ed25519 public",
    },
  };
}

class FakeSshServer {
  readonly client = new FakeSshClient(this);
  readonly commands: string[] = [];
  readonly hostKey = new Uint8Array([1, 2, 3]);
  readonly killSignals: string[] = [];
  readonly module = {
    Client: class {
      constructor() {
        return fakeServer!.client;
      }
    },
    utils: {
      generateKeyPairSync() {
        return { private: "private", public: "public" };
      },
    },
  };
  boxDestroys = 0;
  connects = 0;
  holdConnect = false;
  holdObservation = false;
  holdExec = false;
  holdSftpOpen = false;
  holdSftpRead = false;
  observation: FakeChannel | undefined;
  process: FakeChannel | undefined;
  processStderr = [] as string[];
  processStdout = ["started"] as string[];
  sftpError: Error | undefined;
  sftpOpens = 0;
  sftpReads = 0;
  verificationExitCode = 0;
  readonly writtenFiles: Array<{ contents: string; mode?: number; path: string }> = [];
  unitCollected = false;

  constructor() {
    fakeServer = this;
  }

  execute(command: string) {
    this.commands.push(command);
    const channel = new FakeChannel();
    if (command.includes("systemd-run")) {
      this.process = channel;
      for (const chunk of this.processStdout) channel.write(chunk);
      for (const chunk of this.processStderr) channel.stderr.write(chunk);
    } else if (command.includes("systemctl kill")) {
      const signal = command.match(/--signal=SIG([A-Z]+)/)?.[1] ?? "TERM";
      this.killSignals.push(signal);
      setImmediate(() => {
        channel.finish(0);
        this.process?.finish(0);
      });
    } else if (command.includes("ControlGroup")) {
      setImmediate(() =>
        channel.finish(
          this.verificationExitCode,
          this.verificationExitCode === 0
            ? this.unitCollected
              ? "LoadState=not-found\nActiveState=inactive\nControlGroup=\n"
              : "LoadState=loaded\nActiveState=inactive\nControlGroup=/system.slice/vitehub-test.service\n"
            : "",
          this.verificationExitCode === 0 ? "" : "systemctl unavailable",
        ),
      );
    } else if (command.includes("LoadState") && command.includes("ActiveState")) {
      if (this.holdObservation) this.observation = channel;
      else setImmediate(() => channel.finish(0, "loaded\nactive\n"));
    } else if (command.includes("cgroup.procs")) {
      setImmediate(() => channel.finish(0));
    } else {
      setImmediate(() => channel.finish(0));
    }
    return channel;
  }

  releaseObservation() {
    this.observation?.finish(0, "loaded\nactive\n");
  }
}

let fakeServer: FakeSshServer | undefined;

class FakeSshClient extends EventEmitter {
  destroyed = false;
  ended = false;

  constructor(private readonly server: FakeSshServer) {
    super();
  }

  connect(options: { hostVerifier: (key: Buffer) => boolean }) {
    this.server.connects++;
    if (this.server.holdConnect) return;
    queueMicrotask(() => {
      if (options.hostVerifier(Buffer.from(this.server.hostKey))) this.emit("ready");
      else this.emit("error", new Error("host key rejected"));
    });
  }

  destroy() {
    this.destroyed = true;
  }

  end() {
    this.ended = true;
  }

  exec(command: string, callback: (error: Error | null, channel: FakeChannel) => void) {
    if (this.server.holdExec) return;
    callback(null, this.server.execute(command));
  }

  sftp(callback: (error: Error | null, sftp: FakeSftp) => void) {
    this.server.sftpOpens++;
    if (this.server.holdSftpOpen) return;
    callback(this.server.sftpError ?? null, new FakeSftp(this.server));
  }
}

class FakeSftp {
  constructor(private readonly server: FakeSshServer) {}

  end() {}

  readFile(
    _path: string,
    callback: (error: NodeJS.ErrnoException | null, contents: Buffer) => void,
  ) {
    this.server.sftpReads++;
    if (this.server.holdSftpRead) return;
    callback(null, Buffer.alloc(0));
  }

  writeFile(
    path: string,
    contents: Buffer,
    options:
      | { mode: number }
      | ((error: NodeJS.ErrnoException | null, value: void) => void),
    callback?: (error: NodeJS.ErrnoException | null, value: void) => void,
  ) {
    this.server.writtenFiles.push({
      contents: contents.toString(),
      mode: typeof options === "function" ? undefined : options.mode,
      path,
    });
    (typeof options === "function" ? options : callback!)(null, undefined);
  }
}

class FakeChannel extends PassThrough {
  readonly stderr = new PassThrough();
  private finished = false;

  constructor() {
    super({ autoDestroy: false });
  }

  finish(code: number, stdout = "", stderr = "") {
    if (this.finished) return;
    this.finished = true;
    if (stdout) this.write(stdout);
    if (stderr) this.stderr.write(stderr);
    this.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.emit("exit", code);
      this.emit("close", code);
    });
  }
}
