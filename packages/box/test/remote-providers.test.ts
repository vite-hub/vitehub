import { afterEach, describe, expect, it, vi } from "vitest";

import { createCloudflareRuntime, type CloudflareSandboxStub } from "../src/cloudflare.ts";
import { resolveBox } from "../src/index.ts";
import { createVercelRuntime, type VercelSandboxInstance } from "../src/vercel.ts";

afterEach(() => vi.useRealTimers());

describe("remote Box providers", () => {
  it("resolves a selected Cloudflare runtime through the public Box root", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const box = await resolveBox({
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {}, { requires: ["node", "npm"] });

    expect(box.plan.requirements).toEqual([
      { command: "node", name: "node" },
      { command: "npm", name: "npm" },
    ]);
    const session = await box.open({ id: "selected-cloudflare" });
    expect(session.id).toBe("selected-cloudflare");
    await session.close();
  });

  it("reports remote requirement output without exposing Box environment values", async () => {
    const stub = cloudflareStub(async () => ({
      exitCode: 2,
      stderr: "",
      stdout: "credential remote-secret was rejected",
      success: false,
    }));
    const box = await resolveBox({
      env: { ACCESS_TOKEN: "remote-secret" },
      requires: [{ command: "node", args: ["--version"], timeout: 5_000 }],
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});

    expect(box.plan.requirements).toEqual([
      { command: "node", name: "node --version", timeout: 5_000 },
    ]);
    const failure = await box.open().catch((error: unknown) => error as Error) as Error;
    expect(failure.message).toContain("exit code 2: credential [redacted] was rejected");
    expect(failure.message).not.toContain("remote-secret");
  });

  it("bounds remote requirement checks with their configured timeout", async () => {
    const stub = cloudflareStub(async () => await new Promise<never>(() => {}));
    const box = await resolveBox({
      requires: [{ command: "node", timeout: 20 }],
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});

    await expect(box.open()).rejects.toThrow("timed out after 20ms");
  });

  it("preserves caller cancellation during remote requirement checks", async () => {
    const stub = cloudflareStub(async () => await new Promise<never>(() => {}));
    const box = await resolveBox({
      requires: ["node"],
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});
    const controller = new AbortController();
    const reason = new Error("cancel requirement setup");

    const opening = box.open({ signal: controller.signal });
    controller.abort(reason);

    await expect(opening).rejects.toBe(reason);
  });

  it("normalizes authority from tagged remote runtimes", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const cloudflare = await resolveBox({
      runtime: { getSandbox: () => stub, kind: "cloudflare", namespace: namespace(stub) },
    }, {});
    const vercel = await resolveBox({
      runtime: { create: async () => vercelInstance(), kind: "vercel" },
    }, {});

    for (const box of [cloudflare, vercel]) {
      expect(Object.isFrozen(box.plan)).toBe(true);
      expect(Object.isFrozen(box.plan.executionAuthority)).toBe(true);
      expect(Object.isFrozen(box.plan.executionAuthority.filesystem)).toBe(true);
      const session = await box.open();
      expect(session.executionAuthority).toBe(box.plan.executionAuthority);
      await session.close();
    }
  });

  it("retries transient Cloudflare transport failures", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stub = cloudflareStub(async () => {
      calls++;
      if (calls === 1) throw new Error("Durable Object reset while container is starting");
      return { exitCode: 0, stderr: "", stdout: "ready", success: true };
    });
    const box = await resolveBox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await box.open();

    const result = session.exec("probe");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ code: 0, stdout: "ready" });
    expect(calls).toBe(2);
    await session.close();
  });

  it("bounds Cloudflare operations with a deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const stub = cloudflareStub(async () => {
      calls++;
      return await new Promise<never>(() => {});
    });
    const box = await resolveBox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await box.open();

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
    const box = await resolveBox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await box.open();
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
    const box = await resolveBox({ runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await box.open();
    const controller = new AbortController();

    const result = session.exec("probe", [], { signal: controller.signal });
    controller.abort(new Error("cancel exec"));

    await expect(result).rejects.toThrow("cancel exec");
    finishCleanup();
    await session.close();
  });

  it("passes cancellation through Vercel provisioning", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const box = await resolveBox({
      runtime: createVercelRuntime({
        async create(options) {
          received = options.signal;
          return await new Promise<VercelSandboxInstance>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
        },
      }),
    }, {});

    const opened = box.open({ signal: controller.signal });
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
    const box = await resolveBox({
      runtime: createVercelRuntime({ create: async () => instance }),
    }, {});

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
    const box = await resolveBox({
      runtime: createVercelRuntime({
        create: async () => vercelInstance(),
        ...(networkPolicy === undefined ? {} : { networkPolicy }),
      }),
    }, {});

    expect(box.plan.executionAuthority).toMatchObject({
      filesystem: { access: "read-write", scope: "sandbox" },
      isolation: "microvm",
      network,
      processes: "arbitrary",
    });
  });

  it("keeps Cloudflare network authority explicit when the namespace policy is opaque", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const box = await resolveBox({
      runtime: createCloudflareRuntime({ getSandbox: () => stub, namespace: namespace(stub) }),
    }, {});

    expect(box.plan.executionAuthority).toMatchObject({
      filesystem: { access: "read-write", scope: "sandbox" },
      isolation: "container",
      network: "unknown",
      processes: "arbitrary",
    });
  });

  it("does not advertise undeclared Vercel ports", async () => {
    const instance = vercelInstance();
    const box = await resolveBox({ runtime: createVercelRuntime({ create: async () => instance }) }, {});
    const session = await box.open();

    expect(session.ports).toBeUndefined();
    await session.close();
  });
});

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

function vercelInstance(): VercelSandboxInstance {
  return {
    domain: port => `https://box-${port}.example.com`,
    async mkDir() {},
    async readFileToBuffer() { return null; },
    async runCommand() {
      return { async kill() {}, async stderr() { return ""; }, async stdout() { return ""; }, async wait() { return { exitCode: 0 }; } };
    },
    async stop() {},
    async writeFiles() {},
  };
}
