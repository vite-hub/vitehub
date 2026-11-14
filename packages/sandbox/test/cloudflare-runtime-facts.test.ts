import { describe, expect, it } from "vitest";

import { createCloudflareRuntime, type CloudflareSandboxStub } from "../src/cloudflare.ts";
import { resolveSandbox } from "../src/index.ts";

/** A Durable Object stub like the built-in one: every command succeeds, and a spawned process runs until killed. */
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
