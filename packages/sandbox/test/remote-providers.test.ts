import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";

import { createCloudflareRuntime, type CloudflareSandboxStub } from "../src/cloudflare.ts";
import { resolveSandbox } from "../src/index.ts";
import { createVercelRuntime, type VercelSandboxCommand, type VercelSandboxNetworkPolicy, type VercelSandboxInstance } from "../src/vercel.ts";

afterEach(() => vi.useRealTimers());

describe("remote Sandbox providers", () => {
  it.each(["cloudflare", "vercel"] as const)("retries failed %s cleanup without reopening the session", async (provider) => {
    const cleanup = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("provider cleanup failed"))
      .mockResolvedValue(undefined);
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    stub.destroy = cleanup;
    const instance = vercelInstance();
    instance.stop = cleanup;
    const runtime = provider === "cloudflare"
      ? createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) })
      : createVercelRuntime({ create: async () => instance });
    const sandbox = await resolveSandbox({ runtime }, {});
    const session = await sandbox.open();

    await expect(session.close()).rejects.toThrow("provider cleanup failed");
    await expect(session.exec("probe")).rejects.toThrow("Sandbox session is closed");
    await expect(session.files.exists("/workspace")).rejects.toThrow("Sandbox session is closed");

    await session.close();
    await session.close();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("streams Vercel process output before exit and forwards stdin only when requested", async () => {
    const spawned: Array<{ stdin?: boolean }> = [];
    const written: string[] = [];
    let stdinClosed = 0;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => finish = resolve);
    const instance = vercelInstance();
    instance.runCommand = async (options) => {
      if (options.args?.[1] !== "provider") return vercelCommand("");
      spawned.push({ stdin: options.stdin });
      return {
        ...vercelCommand(""),
        async closeStdin() { stdinClosed++; },
        async *logs() {
          yield { data: "ready\n", stream: "stdout" as const };
          await finished;
          yield { data: "done\n", stream: "stderr" as const };
        },
        async stdout() { await finished; return "ready\n"; },
        async wait() { await finished; return { exitCode: 0 }; },
        async writeStdin(data) { written.push(new TextDecoder().decode(data)); },
      };
    };
    const session = await (await resolveSandbox({ runtime: createVercelRuntime({ create: async () => instance }) }, {})).open();
    try {
      const child = await session.spawn!("provider", [], { stdin: true });
      const stdout = child.stdout.getReader();
      const firstChunk = await Promise.race([
        stdout.read().then(chunk => new TextDecoder().decode(chunk.value)),
        new Promise(resolve => setTimeout(resolve, 1000, "still buffered")),
      ]);
      expect(firstChunk).toBe("ready\n");

      const stdin = child.stdin!.getWriter();
      await stdin.write(new TextEncoder().encode("request\n"));
      await stdin.close();
      expect(written).toEqual(["request\n"]);
      expect(stdinClosed).toBe(1);

      finish();
      await expect(new Response(child.stderr).text()).resolves.toBe("done\n");
      await expect(child.wait()).resolves.toEqual({ code: 0 });

      const withoutInput = await session.spawn!("provider");
      expect(withoutInput.stdin).toBeUndefined();
      expect(spawned).toEqual([{ stdin: true }, { stdin: undefined }]);
      await withoutInput.wait();
    }
    finally {
      await session.close();
    }
  });

  it.each(["stderr", "stdout"] as const)("bounds unread Vercel %s without blocking the other channel", async (unread) => {
    const consumed = unread === "stderr" ? "stdout" : "stderr";
    const { child, session } = await spawnVercelCommand({
      ...vercelCommand(""),
      async *logs() {
        // Eight MiB of UTF-8 output must not remain queued in the unread channel.
        for (let index = 0; index < 128; index++) {
          yield { data: "é".repeat(32 * 1024), stream: unread };
        }
        yield { data: "still live\n", stream: consumed };
      },
    });
    try {
      await expect(new Response(child[consumed]).text()).resolves.toBe("still live\n");
      await expect(child[unread].getReader().read()).rejects.toThrow(`${unread} exceeded the 1048576-byte output buffer limit`);
    } finally {
      await session.close();
    }
  });

  it("bounds Vercel output when a reader stops keeping up", async () => {
    let resume!: () => void;
    const resumed = new Promise<void>(resolve => resume = resolve);
    const { child, session } = await spawnVercelCommand({
      ...vercelCommand(""),
      async *logs() {
        yield { data: "first\n", stream: "stderr" as const };
        await resumed;
        for (let index = 0; index < 128; index++) {
          yield { data: "x".repeat(64 * 1024), stream: "stderr" as const };
        }
        yield { data: "still live\n", stream: "stdout" as const };
      },
    });
    try {
      const reader = child.stderr.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
      resume();
      await expect(new Response(child.stdout).text()).resolves.toBe("still live\n");
      await expect(reader.read()).rejects.toThrow("stderr exceeded the 1048576-byte output buffer limit");
    } finally {
      resume();
      await session.close();
    }
  });

  it.each([
    { label: "multi-megabyte", data: "x".repeat(4 * 1024 * 1024) },
    { label: "multibyte", data: "é".repeat(768 * 1024) },
  ])("bounds encoding allocations for oversized $label Vercel log entries", async ({ data }) => {
    let resume!: () => void;
    const resumed = new Promise<void>(resolve => resume = resolve);
    const prefix = "queued\n";
    const { child, session } = await spawnVercelCommand({
      ...vercelCommand(""),
      async *logs() {
        await resumed;
        yield { data: prefix, stream: "stderr" as const };
        yield { data, stream: "stderr" as const };
        yield { data: "still live\n", stream: "stdout" as const };
      },
    });
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const encodeInto = vi.spyOn(TextEncoder.prototype, "encodeInto");
    try {
      resume();
      await expect(new Response(child.stdout).text()).resolves.toBe("still live\n");
      await expect(child.stderr.getReader().read()).rejects.toMatchObject({ code: "SANDBOX_R0159" });
      const capacity = 1024 * 1024 - prefix.length;
      for (const [index, [input]] of encode.mock.calls.entries()) {
        if (input === data) expect(encode.mock.results[index]!.value.byteLength).toBeLessThanOrEqual(capacity);
      }
      for (const [input, destination] of encodeInto.mock.calls) {
        if (input === data) expect(destination.byteLength).toBeLessThanOrEqual(capacity);
      }
    } finally {
      encode.mockRestore();
      encodeInto.mockRestore();
      await session.close();
    }
  });

  it.each(["stderr", "stdout"] as const)("keeps Vercel %s live after cancelling its sibling", async (consumed) => {
    let resume!: () => void;
    const resumed = new Promise<void>(resolve => resume = resolve);
    const cancelled = consumed === "stderr" ? "stdout" : "stderr";
    const { child, session } = await spawnVercelCommand({
      ...vercelCommand(""),
      async *logs() {
        await resumed;
        yield { data: "ignored\n", stream: cancelled };
        yield { data: "still live\n", stream: consumed };
      },
    });
    try {
      await child[cancelled].cancel();
      resume();
      await expect(new Response(child[consumed]).text()).resolves.toBe("still live\n");
    } finally {
      resume();
      await session.close();
    }
  });

  it("closes the Vercel log iterator when both channels are cancelled during a pending read", async () => {
    let signal: AbortSignal | undefined;
    let resume!: () => void;
    const closed = vi.fn();
    const { child, session } = await spawnVercelCommand({
      ...vercelCommand(""),
      async *logs(options?: { signal?: AbortSignal }) {
        signal = options?.signal;
        try {
          await new Promise<void>((resolve) => {
            resume = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          yield { data: "late output", stream: "stdout" as const };
        } finally {
          closed();
        }
      },
    });
    try {
      await child.stdout.cancel();
      expect(closed).not.toHaveBeenCalled();
      await child.stderr.cancel();
      expect(closed).toHaveBeenCalledOnce();
      expect(signal?.aborted).toBe(true);
    } finally {
      resume();
      await session.close();
    }
  });

  it.each(["cloudflare", "vercel"] as const)("uses the shared command listing through the %s Sandbox interface", async provider => {
    const output = "f\t7\t/workspace/with\ttab\0d\t0\t/workspace/nested\0";
    const stub = cloudflareStub(async command => ({
      exitCode: 0, stderr: "", stdout: command.startsWith("find ") ? output : "", success: true,
    }));
    const instance = vercelInstance();
    instance.runCommand = async options => vercelCommand(options.args?.[1]?.startsWith("find ") ? output : "");
    const runtime = provider === "cloudflare"
      ? createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) })
      : createVercelRuntime({ create: async () => instance });
    const session = await (await resolveSandbox({ runtime }, {})).open();
    try {
      await expect(session.files.list("/workspace")).resolves.toEqual([
        { path: "/workspace/nested", size: undefined, type: "directory" },
        { path: "/workspace/with\ttab", size: 7, type: "file" },
      ]);
    } finally {
      await session.close();
    }
  });

  it("resolves a selected Cloudflare runtime through the public Sandbox root", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const sandbox = await resolveSandbox({
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {}, { requires: ["node", "npm"] });

    expect(sandbox.plan.requirements).toEqual([
      { command: "node", name: "node" },
      { command: "npm", name: "npm" },
    ]);
    const session = await sandbox.open({ id: "selected-cloudflare" });
    expect(session.id).toBe("selected-cloudflare");
    await session.close();
  });

  it("reports remote requirement output without exposing Sandbox environment values", async () => {
    const stub = cloudflareStub(async () => ({
      exitCode: 2,
      stderr: "",
      stdout: "credential remote-secret was rejected",
      success: false,
    }));
    const sandbox = await resolveSandbox({
      env: { ACCESS_TOKEN: "remote-secret" },
      requires: [{ command: "node", args: ["--version"], timeout: 5_000 }],
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});

    expect(sandbox.plan.requirements).toEqual([
      { command: "node", name: "node --version", timeout: 5_000 },
    ]);
    const failure = await sandbox.open().catch((error: unknown) => error as Error) as Error;
    expect(failure.message).toContain("exit code 2: credential [redacted] was rejected");
    expect(failure.message).not.toContain("remote-secret");
  });

  it("bounds remote requirement checks with their configured timeout", async () => {
    const stub = cloudflareStub(async () => await new Promise<never>(() => {}));
    const sandbox = await resolveSandbox({
      requires: [{ command: "node", timeout: 20 }],
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});

    await expect(sandbox.open()).rejects.toThrow("timed out after 20ms");
  });

  it("preserves caller cancellation during remote requirement checks", async () => {
    const stub = cloudflareStub(async () => await new Promise<never>(() => {}));
    const sandbox = await resolveSandbox({
      requires: ["node"],
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});
    const controller = new AbortController();
    const reason = new Error("cancel requirement setup");

    const opening = sandbox.open({ signal: controller.signal });
    controller.abort(reason);

    await expect(opening).rejects.toBe(reason);
  });

  it("streams Cloudflare spawn output until the process exits", async () => {
    let finish!: () => void;
    const exited = new Promise<void>(resolve => finish = resolve);
    let emit!: (event: Record<string, unknown>) => void;
    let end!: () => void;
    const logs = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        emit = event => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        end = () => controller.close();
      },
    });
    const stub: CloudflareSandboxStub = {
      ...cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true })),
      async startProcess() {
        return {
          async getLogs() { return { stderr: "", stdout: "first\n" }; },
          id: "process-1",
          async kill() {},
          async waitForExit() {
            await exited;
            return { exitCode: 3 };
          },
        };
      },
      async streamProcessLogs(processId) {
        expect(processId).toBe("process-1");
        return logs;
      },
    };
    const sandbox = await resolveSandbox({
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});
    const session = await sandbox.open();
    const process = await session.spawn!("long-running");
    const stdout = new Response(process.stdout).text();
    const stderr = new Response(process.stderr).text();

    emit({ type: "process_info", processId: "process-1" });
    emit({ data: "first\n", type: "stdout" });
    await new Promise(resolve => setTimeout(resolve, 10));
    emit({ data: "second\n", type: "stdout" });
    emit({ data: "warning\n", type: "stderr" });
    emit({ exitCode: 3, type: "exit" });
    end();
    finish();

    await expect(stdout).resolves.toBe("first\nsecond\n");
    await expect(stderr).resolves.toBe("warning\n");
    await expect(process.wait()).resolves.toEqual({ code: 3 });
    await session.close();
  });

  it.each(["stderr", "stdout"] as const)("bounds unread Cloudflare %s without blocking the other channel", async (unread) => {
    const consumed = unread === "stderr" ? "stdout" : "stderr";
    const encoder = new TextEncoder();
    const event = (value: Record<string, unknown>) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    const stub: CloudflareSandboxStub = {
      ...cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true })),
      async startProcess() {
        return {
          async getLogs() { return { stderr: "", stdout: "" }; },
          id: "process-1",
          async kill() {},
          async waitForExit() { return { exitCode: 0 }; },
        };
      },
      async streamProcessLogs() {
        let index = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            // Eight MiB of UTF-8 output must not remain queued in the unread channel.
            if (index < 128) controller.enqueue(event({ data: "é".repeat(32 * 1024), type: unread }));
            else if (index === 128) controller.enqueue(event({ data: "still live\n", type: consumed }));
            else {
              controller.enqueue(event({ exitCode: 0, type: "exit" }));
              controller.close();
            }
            index++;
          },
        });
      },
    };
    const sandbox = await resolveSandbox({
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});
    const session = await sandbox.open();
    try {
      const process = await session.spawn!("noisy");
      await expect(new Response(process[consumed]).text()).resolves.toBe("still live\n");
      await expect(process[unread].getReader().read()).rejects.toMatchObject({ code: "SANDBOX_R0159" });
    } finally {
      await session.close();
    }
  });

  it("reads Cloudflare spawn logs after exit when the stub cannot stream them", async () => {
    let output = "first\n";
    let finish!: () => void;
    const exited = new Promise<void>(resolve => finish = resolve);
    const stub: CloudflareSandboxStub = {
      ...cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true })),
      async startProcess() {
        return {
          async getLogs() { return { stderr: "", stdout: output }; },
          id: "process-1",
          async kill() {},
          async waitForExit() {
            await exited;
            return { exitCode: 0 };
          },
        };
      },
    };
    const sandbox = await resolveSandbox({
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});
    const session = await sandbox.open();
    const process = await session.spawn!("long-running");
    const stdout = new Response(process.stdout).text();

    await new Promise(resolve => setTimeout(resolve, 10));
    output += "second\n";
    finish();

    await expect(stdout).resolves.toBe("first\nsecond\n");
    await session.close();
  });

  it("normalizes authority from tagged remote runtimes", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const cloudflare = await resolveSandbox({
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});
    const vercel = await resolveSandbox({
      runtime: { create: async () => vercelInstance(), kind: "vercel" },
    }, {});

    for (const sandbox of [cloudflare, vercel]) {
      expect(Object.isFrozen(sandbox.plan)).toBe(true);
      expect(Object.isFrozen(sandbox.plan.executionAuthority)).toBe(true);
      expect(Object.isFrozen(sandbox.plan.executionAuthority.filesystem)).toBe(true);
      const session = await sandbox.open();
      expect(session.executionAuthority).toBe(sandbox.plan.executionAuthority);
      await session.close();
    }
  });

  it("retries a safe Cloudflare request when the host marks the failure retryable", async () => {
    vi.useFakeTimers();
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await sandbox.open();
    let writes = 0;
    stub.writeFile = async () => {
      writes++;
      if (writes === 1) throw hostError("Internal error in Durable Object storage.", { retryable: true });
      return { success: true };
    };

    const result = session.files.write("/workspace/output", new TextEncoder().encode("data"));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBeUndefined();
    expect(writes).toBe(2);
    await session.close();
  });

  it.each([
    { flags: { overloaded: true, retryable: true }, name: "an overloaded Durable Object" },
    { flags: { retryable: false }, name: "a non-retryable failure" },
  ])("does not retry a safe Cloudflare request after $name", async ({ flags }) => {
    vi.useFakeTimers();
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await sandbox.open();
    let writes = 0;
    stub.writeFile = async () => {
      writes++;
      throw hostError("Network connection lost.", flags);
    };

    const result = session.files.write("/workspace/output", new TextEncoder().encode("data"));
    const rejection = expect(result).rejects.toThrow("writeFile failed: Network connection lost.");
    await vi.runAllTimersAsync();
    await rejection;
    expect(writes).toBe(1);
    await session.close();
  });

  it("retries a Cloudflare command that failed before the Container was ready", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stub = cloudflareStub(async () => {
      calls++;
      if (calls === 1) throw new Error("The container is starting. Please retry in a moment.");
      return { exitCode: 0, stderr: "", stdout: "ready", success: true };
    });
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await sandbox.open();

    const result = session.exec("probe");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ code: 0, stdout: "ready" });
    expect(calls).toBe(2);
    await session.close();
  });

  it("never retries a Cloudflare command and exposes the host retryable flag", async () => {
    vi.useFakeTimers();
    const lost = hostError("Network connection lost.", { retryable: true });
    let calls = 0;
    const stub = cloudflareStub(async () => {
      calls++;
      throw lost;
    });
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await sandbox.open();

    const result = session.exec("probe");
    const rejection = expect(result).rejects.toMatchObject({ cause: lost, data: { retryable: true } });
    await vi.runAllTimersAsync();
    await rejection;
    expect(calls).toBe(1);
    await session.close();
  });

  it("bounds Cloudflare operations with a deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stub = cloudflareStub(async () => {
      calls++;
      return await new Promise<never>(() => {});
    });
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await sandbox.open();

    const result = session.exec("probe");
    const rejection = expect(result).rejects.toThrow("exec timed out after 180000ms");
    await vi.runAllTimersAsync();
    await rejection;
    expect(calls).toBe(1);
    await session.close();
  });

  it("honors caller Cloudflare execution timeouts beyond the transport default", async () => {
    vi.useFakeTimers();
    let receivedTimeout: number | undefined;
    const stub = cloudflareStub(async (_command, options) => {
      receivedTimeout = options?.timeout;
      await new Promise(resolve => setTimeout(resolve, 200_000));
      return { exitCode: 0, stderr: "", stdout: "complete", success: true };
    });
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await sandbox.open();
    const settled = vi.fn();

    const result = session.exec("long-analysis", [], { timeout: 600_000 });
    void result.then(value => settled({ value }), error => settled({ error }));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toMatchObject({ code: 0, stdout: "complete" });
    expect(receivedTimeout).toBe(600_000);
    await session.close();
  });

  it("rejects Cloudflare cancellation without waiting for cleanup", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const stub = cloudflareStub(async () => await new Promise<never>(() => {}));
    stub.destroy = async () => await cleanup;
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await sandbox.open();
    const controller = new AbortController();

    const result = session.exec("probe", [], { signal: controller.signal });
    controller.abort(new Error("cancel exec"));

    await expect(result).rejects.toThrow("cancel exec");
    const closed = vi.fn();
    const closing = session.close().then(closed);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(closed).not.toHaveBeenCalled();
    finishCleanup();
    await closing;
    expect(closed).toHaveBeenCalledOnce();
  });

  it("rejects Cloudflare file reads when cancellation aborts an in-flight request", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const destroy = vi.fn(async () => {});
    stub.destroy = destroy;
    let reads = 0;
    stub.readFile = async () => {
      reads++;
      if (reads === 1) return await new Promise<never>(() => {});
      return { content: btoa("still open"), success: true };
    };
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await sandbox.open();
    const controller = new AbortController();
    const reason = new Error("cancel read");

    const result = session.files.read("/workspace/output", { signal: controller.signal });
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    await expect(session.files.read("/workspace/output")).resolves.toEqual(new TextEncoder().encode("still open"));
    expect(destroy).not.toHaveBeenCalled();
    await session.close();
  });

  it("passes cancellation through Vercel provisioning", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const sandbox = await resolveSandbox({
      runtime: createVercelRuntime({
        async create(options) {
          received = options.signal;
          return await new Promise<VercelSandboxInstance>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
        },
      }),
    }, {});

    const opened = sandbox.open({ signal: controller.signal });
    await vi.waitFor(() => expect(received).toBe(controller.signal));
    controller.abort(new Error("cancel provisioning"));
    await expect(opened).rejects.toThrow("cancel provisioning");
    expect(received).toBe(controller.signal);
  });

  it("preserves initialization and cleanup failures", async () => {
    const instance = vercelInstance();
    instance.stop = async () => {
      throw new Error("provider cleanup failed");
    };
    const sandbox = await resolveSandbox({
      runtime: createVercelRuntime({ create: async () => instance }),
    }, {});

    let failure: unknown;
    try {
      await sandbox.open({
        async initialize() {
          throw new Error("initialization failed");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "initialization failed" }),
      expect.objectContaining({ message: "provider cleanup failed" }),
    ]);
    expect((failure as AggregateError).message).toContain("initialization failed");
    expect((failure as AggregateError).message).toContain("provider cleanup failed");
  });

  it.each([
    [undefined, "unrestricted"],
    ["allow-all" as const, "unrestricted"],
    ["deny-all" as const, "none"],
    [{ allow: ["api.example.com"] }, "restricted"],
    [{ allow: ["*"] }, "unrestricted"],
    [{ allow: { "*": [] } }, "unrestricted"],
    [{ allow: ["*"], subnets: { deny: ["10.0.0.0/8"] } }, "restricted"],
    [{}, "unknown"],
    [{ allow: [] }, "unknown"],
    [{ subnets: {} }, "unknown"],
    [{ subnets: { deny: ["10.0.0.0/8"] } }, "restricted"],
  ])("declares Vercel network authority for %j", async (networkPolicy, network) => {
    const sandbox = await resolveSandbox({
      runtime: createVercelRuntime({
        create: async () => vercelInstance(),
        ...(networkPolicy === undefined ? {} : { networkPolicy }),
      }),
    }, {});

    expect(sandbox.plan.executionAuthority).toMatchObject({
      filesystem: { access: "read-write", scope: "sandbox" },
      isolation: "microvm",
      network,
      processes: "arbitrary",
    });
  });

  it("does not infer unrestricted network access from an inherited wildcard", async () => {
    const allow = Object.create({ "*": [] }) as Record<string, readonly unknown[]>;
    const sandbox = await resolveSandbox({
      runtime: createVercelRuntime({
        create: async () => vercelInstance(),
        networkPolicy: { allow },
      }),
    }, {});

    expect(sandbox.plan.executionAuthority.network).toBe("unknown");
  });

  it.each([
    Object.create({ allow: ["*"] }) as Exclude<VercelSandboxNetworkPolicy, string>,
    Object.create({ subnets: { deny: ["10.0.0.0/8"] } }) as Exclude<VercelSandboxNetworkPolicy, string>,
    { allow: Object.setPrototypeOf(Object.assign([], { length: 1 }), { 0: "*" }) },
    { allow: Object.assign([], { length: 1 }) },
    { subnets: { allow: Object.assign([], { length: 1 }) } },
    { subnets: { deny: Object.assign([], { length: 1 }) } },
  ])("does not infer Vercel network authority from inherited policy members", async networkPolicy => {
    const sandbox = await resolveSandbox({
      runtime: createVercelRuntime({
        create: async () => vercelInstance(),
        networkPolicy,
      }),
    }, {});

    expect(sandbox.plan.executionAuthority.network).toBe("unknown");
  });

  it("keeps Cloudflare network authority explicit when the namespace policy is opaque", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const sandbox = await resolveSandbox({
      runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }),
    }, {});

    expect(sandbox.plan.executionAuthority).toMatchObject({
      filesystem: { access: "read-write", scope: "sandbox" },
      isolation: "container",
      network: "unknown",
      processes: "arbitrary",
    });
  });

  it("does not advertise undeclared Vercel ports", async () => {
    const instance = vercelInstance();
    const sandbox = await resolveSandbox({ runtime: createVercelRuntime({ create: async () => instance }) }, {});
    const session = await sandbox.open();

    expect(session.ports).toBeUndefined();
    await session.close();
  });

  it("distinguishes missing Vercel files from filesystem failures", async () => {
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    let accessFailure = missing;
    let readFailure = missing;
    const access = vi.fn(async () => { throw accessFailure; });
    const instance = vercelInstance();
    instance.fs = {
      access,
      async mkdir() {},
      async readFile() { throw readFailure; },
      async readdir() { return []; },
      async rename() {},
      async rm() {},
      async stat() { throw missing; },
      async writeFile() {},
    };
    const sandbox = await resolveSandbox({ runtime: createVercelRuntime({ create: async () => instance }) }, {});
    const session = await sandbox.open();

    await expect(session.files.exists("/workspace/missing.txt")).resolves.toBe(false);
    await expect(session.files.read("/workspace/missing.txt")).resolves.toBeNull();

    const deniedAccess = Object.assign(new Error("permission denied"), { code: "EACCES" });
    accessFailure = deniedAccess;
    await expect(session.files.exists("/workspace/private.txt")).rejects.toBe(deniedAccess);

    const deniedRead = Object.assign(new Error("read denied"), { code: "EACCES" });
    readFailure = deniedRead;
    const accessCalls = access.mock.calls.length;
    await expect(session.files.read("/workspace/private.txt")).rejects.toBe(deniedRead);
    expect(access).toHaveBeenCalledTimes(accessCalls);
    await session.close();
  });

  it("recognizes cross-realm missing Vercel files", async () => {
    const missing = runInNewContext("Object.assign(new Error('missing'), { code: 'ENOENT' })") as Error & { code: string };
    const instance = vercelInstance();
    instance.fs = {
      async access() { throw missing; },
      async mkdir() {},
      async readFile() { throw missing; },
      async readdir() { return []; },
      async rename() {},
      async rm() {},
      async stat() { throw missing; },
      async writeFile() {},
    };
    const sandbox = await resolveSandbox({ runtime: createVercelRuntime({ create: async () => instance }) }, {});
    const session = await sandbox.open();

    await expect(session.files.exists("/workspace/missing.txt")).resolves.toBe(false);
    await expect(session.files.read("/workspace/missing.txt")).resolves.toBeNull();
    await session.close();
  });
});

function hostError(message: string, flags: { overloaded?: boolean; retryable?: boolean }) {
  return Object.assign(new Error(message), flags);
}

function namespace(stub: CloudflareSandboxStub) {
  return { get: () => stub, idFromName: (name: string) => name };
}

function cloudflareStub(exec: CloudflareSandboxStub["exec"]): CloudflareSandboxStub {
  return {
    async destroy() {},
    async exec(command, options) {
      if (command.startsWith("rm -rf -- "))
        return { exitCode: 0, stderr: "", stdout: "", success: true };
      if (command.startsWith("test -e "))
        return { exitCode: 1, stderr: "", stdout: "", success: false };
      return await exec(command, options);
    },
    async mkdir() { return { success: true }; },
    async readFile() { return { content: "", success: false }; },
    async writeFile() { return { success: true }; },
  };
}

async function spawnVercelCommand(command: VercelSandboxCommand) {
  const instance = vercelInstance();
  instance.runCommand = async options => options.args?.[1] === "provider" ? command : vercelCommand("");
  const session = await (await resolveSandbox({ runtime: createVercelRuntime({ create: async () => instance }) }, {})).open();
  return { child: await session.spawn!("provider"), session };
}

function vercelCommand(stdout: string): VercelSandboxCommand {
  return {
    async closeStdin() {},
    async kill() {},
    async *logs() {
      if (stdout) yield { data: stdout, stream: "stdout" as const };
    },
    async stderr() { return ""; },
    async stdout() { return stdout; },
    async wait() { return { exitCode: 0 }; },
    async writeStdin() {},
  };
}

function vercelInstance(): VercelSandboxInstance {
  return {
    domain: port => `https://sandbox-${port}.example.com`,
    async mkDir() {},
    async readFileToBuffer() { return null; },
    async runCommand() {
      return vercelCommand("");
    },
    async stop() {},
    async writeFiles() {},
  };
}
