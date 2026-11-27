import { describe, expect, it, vi } from "vitest";

import { createCloudflareRuntime, type CloudflareSandboxStub } from "../src/cloudflare.ts";
import { resolveSandbox } from "../src/index.ts";

function sandboxObject() {
  const kills: Array<string | undefined> = [];
  const object = {
    async cancelExec() {},
    async configure() {},
    async deleteFile() { return { success: true }; },
    async destroy() {},
    async exec() { return { exitCode: 0, stderr: "", stdout: "", success: true }; },
    async exists() { return { exists: false }; },
    async mkdir() { return { success: true }; },
    async moveFile() { return { success: true }; },
    async readFile() { return { content: "", success: false }; },
    async startProcess() {
      let exit!: (code: number) => void;
      const exited = new Promise<number>(resolve => exit = resolve);
      return {
        id: "process",
        async getLogs() { return { stderr: "", stdout: "" }; },
        async kill(signal?: string) {
          kills.push(signal);
          exit(143);
        },
        async waitForExit() { return { exitCode: await exited }; },
      };
    },
    async writeFile() { return { success: true }; },
  };
  return { kills, namespace: { get: () => object, idFromName: (name: string) => name }, object };
}

describe("Cloudflare runtime facts", () => {
  it("reports unrestricted network for the built-in Sandbox, which starts Containers with internet access", async () => {
    const { namespace } = sandboxObject();
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ namespace }) }, {});

    expect(sandbox.plan.executionAuthority.network).toBe("unrestricted");
  });

  it.each([
    ["allow-all" as const, "unrestricted"],
    ["deny-all" as const, "none"],
    [{ allow: [] }, "none"],
    [{ allow: ["api.example.com", "*.github.com"] }, "restricted"],
    [{ allow: ["api.example.com", "*"] }, "unrestricted"],
  ])("reports the network of networkPolicy %j", async (networkPolicy, network) => {
    const { namespace } = sandboxObject();
    const sandbox = await resolveSandbox({ runtime: createCloudflareRuntime({ namespace, networkPolicy }) }, {});

    expect(sandbox.plan.executionAuthority.network).toBe(network);
  });

  it("sends the validated policy to the Durable Object", async () => {
    const { namespace, object } = sandboxObject();
    const configure = vi.spyOn(object, "configure");
    const session = await (await resolveSandbox({
      runtime: createCloudflareRuntime({ namespace, networkPolicy: { allow: ["B.example.com", "a.example.com"] } }),
    }, {})).open();
    await session.exec("true");

    expect(configure).toHaveBeenCalledWith({ keepAlive: undefined, networkPolicy: { allow: ["a.example.com", "b.example.com"] }, sleepAfter: undefined });
    await session.close();
  });

  it.each([
    ["subnets", { allow: ["api.example.com"], subnets: { allow: ["10.0.0.0/8"] } }, "Only Vercel supports subnets"],
    ["an IP address", { allow: ["203.0.113.7"] }, "is an IP address"],
    ["a URL", { allow: ["https://api.example.com"] }, "is not a hostname"],
    ["a top-level wildcard", { allow: ["*.com"] }, "is not a hostname"],
    ["65 hosts", { allow: Array.from({ length: 65 }, (_, index) => `h${index}.example.com`) }, "at most 64"],
    ["an unknown name", "none", "must be \"allow-all\", \"deny-all\""],
  ])("rejects a networkPolicy with %s with SANDBOX_NETWORK_POLICY_INVALID", (_, networkPolicy, message) => {
    const { namespace } = sandboxObject();

    expect(() => createCloudflareRuntime({ namespace, networkPolicy: networkPolicy as never })).toThrow(expect.objectContaining({
      code: "SANDBOX_NETWORK_POLICY_INVALID",
      message: expect.stringContaining(message),
    }));
  });

  it("rejects networkPolicy with a custom getSandbox, which starts the Container itself", () => {
    const { namespace, object } = sandboxObject();

    expect(() => createCloudflareRuntime({ getSandbox: () => object as CloudflareSandboxStub, namespace, networkPolicy: "deny-all" }))
      .toThrow(expect.objectContaining({ code: "SANDBOX_NETWORK_POLICY_INVALID" }));
  });

  it("keeps the network unknown for a custom getSandbox", async () => {
    const { namespace, object } = sandboxObject();
    const runtime = createCloudflareRuntime({ getSandbox: () => object as CloudflareSandboxStub, namespace });
    const sandbox = await resolveSandbox({ runtime }, {});

    expect(sandbox.plan.executionAuthority.network).toBe("unknown");
  });

  it("rejects a signal that the built-in Sandbox cannot send with SANDBOX_R0165", async () => {
    const { kills, namespace } = sandboxObject();
    const session = await (await resolveSandbox({ runtime: createCloudflareRuntime({ namespace }) }, {})).open();
    const child = await session.spawn!("sleep", ["600"]);

    await expect(child.kill("SIGWINCH")).rejects.toMatchObject({ code: "SANDBOX_R0165" });
    expect(kills).toEqual([]);

    await child.kill("SIGTERM");
    expect(kills).toEqual(["SIGTERM"]);
    await expect(child.wait()).resolves.toEqual({ code: 143 });
    await session.close();
  });

  it("leaves signal checks to a custom getSandbox", async () => {
    const { kills, namespace, object } = sandboxObject();
    const runtime = createCloudflareRuntime({ getSandbox: () => object as CloudflareSandboxStub, namespace });
    const session = await (await resolveSandbox({ runtime }, {})).open();
    const child = await session.spawn!("sleep", ["600"]);

    await child.kill("SIGWINCH");
    expect(kills).toEqual(["SIGWINCH"]);
    await session.close();
  });
});
