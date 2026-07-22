import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudflareBox, resolveCloudflareBox, type CloudflareSandboxStub } from "../src/cloudflare.ts";
import { resolveBox } from "../src/index.ts";
import { resolveVercelBox, vercelBox, type VercelSandboxInstance } from "../src/vercel.ts";

afterEach(() => vi.useRealTimers());

describe("remote Box providers", () => {
  it("resolves a selected Cloudflare runtime without the public Box root", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const box = await resolveCloudflareBox({ getSandbox: () => stub, namespace: namespace(stub) }, ["node", "npm"]);

    expect(box.plan.requirements).toEqual([
      { command: "node", name: "node" },
      { command: "npm", name: "npm" },
    ]);
    const session = await box.open({ id: "selected-cloudflare" });
    expect(session.id).toBe("selected-cloudflare");
    await session.close();
  });

  it("normalizes authority from direct remote resolvers", async () => {
    const stub = cloudflareStub(async () => ({ exitCode: 0, stderr: "", stdout: "", success: true }));
    const cloudflare = await resolveCloudflareBox({ getSandbox: () => stub, namespace: namespace(stub) }, []);
    const vercel = await resolveVercelBox({ create: async () => vercelInstance() }, []);

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
    const box = await resolveBox({ runtime: cloudflareBox({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await box.open();

    const result = session.exec("probe");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ code: 0, stdout: "ready" });
    expect(calls).toBe(2);
    await session.close();
  });

  it("bounds Cloudflare operations with a deadline", async () => {
    vi.useFakeTimers();
    const stub = cloudflareStub(async () => await new Promise<never>(() => {}));
    const box = await resolveBox({ runtime: cloudflareBox({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
    const session = await box.open();

    const result = session.exec("probe");
    const rejection = expect(result).rejects.toThrow("exec timed out after 180000ms");
    await vi.advanceTimersByTimeAsync(180_000);
    await rejection;
    await session.close();
  });

  it("rejects Cloudflare cancellation without waiting for cleanup", async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const stub = cloudflareStub(async () => await new Promise<never>(() => {}));
    stub.destroy = async () => await cleanup;
    const box = await resolveBox({ runtime: cloudflareBox({ getSandbox: () => stub, namespace: namespace(stub) }) }, {});
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
      runtime: vercelBox({
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

  it.each([
    [undefined, "unrestricted"],
    ["allow-all" as const, "unrestricted"],
    ["deny-all" as const, "none"],
    [{ allow: ["api.example.com"] }, "restricted"],
    [{}, "unknown"],
    [{ allow: [] }, "unknown"],
    [{ subnets: {} }, "unknown"],
    [{ subnets: { deny: ["10.0.0.0/8"] } }, "restricted"],
  ])("declares Vercel network authority for %j", async (networkPolicy, network) => {
    const box = await resolveBox({
      runtime: vercelBox({
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
      runtime: cloudflareBox({ getSandbox: () => stub, namespace: namespace(stub) }),
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
    const box = await resolveBox({ runtime: vercelBox({ create: async () => instance }) }, {});
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
