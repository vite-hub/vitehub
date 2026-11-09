import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSandbox, type ContainerSandboxOptions } from "../src/index.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

/** A Docker CLI stand-in that records each call and answers the broker readiness probe. */
async function fakeDocker() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-container-"));
  temporary.push(root);
  const log = join(root, "calls.jsonl");
  const docker = join(root, "docker");
  await writeFile(docker, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
const argv = process.argv.slice(2)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("VITEHUB_BROKER_SECRET_") || key === "GH_TOKEN" || key === "PROJECT_ENV"))
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env }) + "\\n")
if (argv.join(" ").includes("socket.create_connection")) process.stdout.write("-----BEGIN CERTIFICATE-----\\nfake\\n-----END CERTIFICATE-----\\n")
process.stdin.resume()
process.stdin.on("end", () => process.exit(0))
`);
  await chmod(docker, 0o755);
  return {
    docker,
    async calls() {
      return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { argv: string[]; env: Record<string, string> });
    },
  };
}

describe("container Sandbox runtime", () => {
  it("is selected by kind and reports container isolation", async () => {
    const caged = await resolveSandbox({ runtime: { kind: "container", image: "node:24" } }, {});
    expect(caged.plan.runtime).toBe("container");
    expect(caged.plan.executionAuthority).toMatchObject({ credentials: "unknown", isolation: "container", network: "none" });

    const restricted = await resolveSandbox({
      runtime: {
        credentials: { GH_TOKEN: { hosts: ["api.github.com"], value: "secret" } },
        egress: { allow: ["registry.npmjs.org"] },
        image: "node:24",
        kind: "container",
      },
    }, {});
    expect(restricted.plan.executionAuthority).toMatchObject({ credentials: "provisioned", network: "restricted" });

    const open = await resolveSandbox({ runtime: { egress: "open", image: "node:24", kind: "container" } }, {});
    expect(open.plan.executionAuthority.network).toBe("unrestricted");
  });

  it("rejects invalid options before a session opens", async () => {
    const cases: [ContainerSandboxOptions, RegExp][] = [
      [{ image: "" }, /image must be a non-empty string/],
      [{ credentials: { GH_TOKEN: { hosts: ["api.github.com"], value: "x" } }, image: "node:24" }, /credentials need egress/],
      [{ credentials: { PATH: { hosts: ["api.github.com"], value: "x" } }, egress: "open", image: "node:24" }, /PATH is managed/],
      [{ credentials: { GH_TOKEN: { hosts: [], value: "x" } }, egress: "open", image: "node:24" }, /requires at least one host/],
      [{ egress: { allow: ["https://example.com"] }, image: "node:24" }, /egress host must be a host name/],
      [{ egress: { allow: ["example.com:99999"] }, image: "node:24" }, /egress host must be a host name/],
      [{ cpus: 0, image: "node:24" }, /cpus must be a positive number/],
      [{ image: "node:24", memoryBytes: 1024 }, /memoryBytes must be a safe integer/],
    ];
    for (const [options, message] of cases) {
      await expect(resolveSandbox({ runtime: { kind: "container", ...options } }, {})).rejects.toThrow(message);
    }
  });

  it("rejects a credential that is also declared in sandbox.env", async () => {
    await expect(resolveSandbox({
      env: { GH_TOKEN: "visible" },
      runtime: { credentials: { GH_TOKEN: { hosts: ["api.github.com"], value: "x" } }, egress: "open", image: "node:24", kind: "container" },
    }, {})).rejects.toThrow(/also declared in sandbox.env/);
  });

  it("keeps credential values off the Docker command line and out of the Sandbox", async () => {
    const fake = await fakeDocker();
    const secret = "ghp_real_secret_value";
    const sandbox = await resolveSandbox({
      env: { PROJECT_ENV: "test" },
      runtime: {
        credentials: { GH_TOKEN: { hosts: ["api.github.com"], value: async () => secret } },
        docker: fake.docker,
        egress: { allow: ["registry.npmjs.org"] },
        image: "node:24",
        kind: "container",
      },
    }, {});
    const session = await sandbox.open();
    await session.exec("true");
    await session.close();

    const calls = await fake.calls();
    for (const call of calls) expect(call.argv.join(" ")).not.toContain(secret);

    const brokerRun = calls.find(call => call.argv[0] === "run" && call.argv.includes("mitmproxy/mitmproxy:12.2.3"));
    expect(brokerRun?.env.VITEHUB_BROKER_SECRET_0).toBe(secret);
    expect(brokerRun?.argv).toEqual(expect.arrayContaining(["--network", "bridge", "-e", "VITEHUB_BROKER_SECRET_0"]));

    const sandboxRun = calls.find(call => call.argv[0] === "run" && call.argv.includes("node:24"));
    expect(sandboxRun?.argv).toEqual(expect.arrayContaining(["--init", "--security-opt", "no-new-privileges:true"]));
    expect(sandboxRun?.argv[sandboxRun.argv.indexOf("--network") + 1]).toMatch(/-net$/);
    expect(calls.some(call => call.argv[0] === "network" && call.argv[1] === "create" && call.argv.includes("--internal"))).toBe(true);

    const command = calls.find(call => call.argv[0] === "exec" && call.argv.includes("true"));
    expect(command?.argv).toEqual(expect.arrayContaining(["-e", "GH_TOKEN", "-e", "PROJECT_ENV"]));
    expect(command?.env.GH_TOKEN).toMatch(/^vitehub-GH_TOKEN-[0-9a-f]{32}$/);
    expect(command?.env.PROJECT_ENV).toBe("test");
    // The Docker CLI reads HOME itself, so the Sandbox value travels inline. Other names are inherited by name only.
    expect(command?.argv).toEqual(expect.arrayContaining(["-e", "HOME=/vitehub/home", "-e", "HTTPS_PROXY", "-e", "NODE_EXTRA_CA_CERTS"]));

    const removal = calls.find(call => call.argv[0] === "rm" && call.argv[1] === "-f");
    expect(removal?.argv).toHaveLength(4);
    expect(calls.at(-1)?.argv.slice(0, 2)).toEqual(["network", "rm"]);
  });
});

const dockerTests = process.env.VITEHUB_SANDBOX_DOCKER_TEST === "1";

/** Runs against a real Docker daemon. Set VITEHUB_SANDBOX_DOCKER_TEST=1 to enable. */
describe.skipIf(!dockerTests)("container Sandbox runtime with Docker", () => {
  const image = process.env.VITEHUB_SANDBOX_DOCKER_IMAGE || "node:24-bookworm";

  it("has no network exit without egress", { timeout: 120_000 }, async () => {
    const session = await (await resolveSandbox({ runtime: { image, kind: "container" } }, {})).open();
    try {
      const result = await session.exec("sh", ["-c", "curl -sS -m 5 https://example.com -o /dev/null"]);
      expect(result.ok).toBe(false);
      await session.files.write("input.bin", new Uint8Array([0, 1, 255]));
      expect(await session.files.read("input.bin")).toEqual(new Uint8Array([0, 1, 255]));
      expect(await session.files.read("missing.bin")).toBeNull();
    } finally {
      await session.close();
    }
  });

  it("brokers egress and credentials", { timeout: 180_000 }, async () => {
    const session = await (await resolveSandbox({
      runtime: {
        credentials: { NPM_TOKEN: { hosts: ["registry.npmjs.org"], value: "real-value" } },
        egress: { allow: ["registry.npmjs.org"] },
        image,
        kind: "container",
      },
    }, {})).open();
    try {
      const placeholder = await session.exec("sh", ["-c", "printf %s \"$NPM_TOKEN\""]);
      expect(placeholder.stdout).toMatch(/^vitehub-NPM_TOKEN-[0-9a-f]{32}$/);

      const allowed = await session.exec("sh", ["-c", "curl -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/vite-hub"]);
      expect(allowed.stdout).toBe("200");

      const denied = await session.exec("sh", ["-c", "curl -sS -o /dev/null -w '%{http_code}' https://example.com; true"]);
      expect(`${denied.stdout}${denied.stderr}`).toContain("403");

      const fetched = await session.exec("node", ["-e", "fetch('https://registry.npmjs.org/vite-hub').then(r => console.log(r.status))"]);
      expect(fetched.stdout.trim()).toBe("200");

      const broker = execFileSync("docker", ["ps", "--filter", "label=dev.vitehub.sandbox", "--filter", "name=-broker", "--format", "{{.Names}}"], { encoding: "utf8" }).trim().split("\n")[0]!;
      await session.exec("sh", ["-c", "curl -sS -o /dev/null -H \"Authorization: Bearer $NPM_TOKEN\" https://registry.npmjs.org/vite-hub"]);
      expect(execFileSync("docker", ["logs", broker], { encoding: "utf8" })).toContain("\"injected\": [\"NPM_TOKEN\"]");

      const child = await session.spawn!("cat", [], { stdin: true });
      const writer = child.stdin!.getWriter();
      await writer.write(new TextEncoder().encode("ping"));
      await writer.close();
      expect(await new Response(child.stdout).text()).toBe("ping");
      expect((await child.wait()).code).toBe(0);

      const sleeper = await session.spawn!("sh", ["-c", "sleep 300"]);
      await new Promise(resolve => setTimeout(resolve, 500));
      await sleeper.kill();
      expect((await sleeper.wait()).code).not.toBe(0);
    } finally {
      await session.close();
    }
    expect(execFileSync("docker", ["ps", "-aq", "--filter", "label=dev.vitehub.sandbox"], { encoding: "utf8" }).trim()).toBe("");
    expect(execFileSync("docker", ["network", "ls", "-q", "--filter", "label=dev.vitehub.sandbox"], { encoding: "utf8" }).trim()).toBe("");
  });
});
