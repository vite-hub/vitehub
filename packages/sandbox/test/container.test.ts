import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSandbox, type ContainerSandboxOptions, type SandboxSession } from "../src/index.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

/** A Docker CLI stand-in that records each call and answers the broker readiness probe. */
async function fakeDocker(options: { processes?: boolean; failSignals?: boolean; serverVersion?: string; serverInfo?: Record<string, unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vitehub-container-"));
  temporary.push(root);
  const log = join(root, "calls.jsonl");
  const docker = join(root, "docker");
  await writeFile(docker, `#!/usr/bin/env node
const { appendFileSync, mkdirSync } = require("node:fs")
const { spawn } = require("node:child_process")
const argv = process.argv.slice(2)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("VITEHUB_BROKER_SECRET_") || key === "GH_TOKEN" || key === "PROJECT_ENV"))
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env }) + "\\n")
const pidRoot = ${JSON.stringify(join(root, "pids"))}
mkdirSync(pidRoot, { recursive: true })
const pidIndex = argv.findIndex(arg => arg.startsWith("/vitehub/.pids/"))
const script = argv[argv.indexOf("-c") + 1] || ""
const signal = script.includes("pid=$(cat")
if (argv[0] === "version") process.stdout.write(${JSON.stringify(options.serverVersion ?? "29.1.3")})
if (argv[0] === "info") process.stdout.write(${JSON.stringify(JSON.stringify(options.serverInfo ?? {
  KernelVersion: "6.8.0-51-generic",
  OSType: "linux",
  OperatingSystem: "Ubuntu 24.04.1 LTS",
  SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
}))})
if (${!!options.processes} && ((pidIndex >= 0 && argv[pidIndex + 1].includes("sleep 1")) || signal)) {
  if (signal && ${!!options.failSignals}) {
    process.stderr.write("signal exec failed")
    process.exit(1)
  }
  const args = argv.slice(argv.indexOf("-c")).map(arg => arg.replaceAll("/vitehub/.pids", pidRoot).replaceAll("/vitehub/workspace", ${JSON.stringify(root)}))
  setTimeout(() => {
    const child = spawn("sh", args, { detached: !signal, stdio: "inherit" })
    child.on("exit", (code, sig) => {
      if (signal) appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: ["signal-result", String(code)], env: {} }) + "\\n")
      process.exit(code ?? (sig ? 128 : 1))
    })
  }, signal ? 0 : 250)
} else {
  if (argv.join(" ").includes("socket.create_connection")) process.stdout.write("-----BEGIN CERTIFICATE-----\\nfake\\n-----END CERTIFICATE-----\\n")
  process.stdin.resume()
  process.stdin.on("end", () => process.exit(0))
}
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

  it.each(["26.1.5", "27.5.1", "unknown"])("rejects daemon %s before creating a network", async (serverVersion) => {
    const fake = await fakeDocker({ serverVersion });
    const sandbox = await resolveSandbox({ runtime: { docker: fake.docker, image: "node:24", kind: "container" } }, {});
    await expect(sandbox.open()).rejects.toThrow(/requires Docker Engine 28 or newer/);
    expect((await fake.calls()).map(call => call.argv[0])).toEqual(["version"]);
  });

  it.each([
    { KernelVersion: "6.10.14-linuxkit", OSType: "linux", OperatingSystem: "Docker Desktop", SecurityOptions: [] },
    { KernelVersion: "6.14.8-orbstack", OSType: "linux", OperatingSystem: "OrbStack", SecurityOptions: [] },
    { KernelVersion: "4.4.0-19041-Microsoft", OSType: "linux", OperatingSystem: "Ubuntu 20.04", SecurityOptions: [] },
    { KernelVersion: "5.15.167.4-microsoft-standard-WSL2", OSType: "linux", OperatingSystem: "Ubuntu 24.04", SecurityOptions: [] },
    { KernelVersion: "6.8.0-generic", OSType: "linux", OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=rootless"] },
    { KernelVersion: "10.0", OSType: "windows", OperatingSystem: "Windows Server", SecurityOptions: [] },
    {},
  ])("rejects unsupported daemon $OperatingSystem before creating resources", async (serverInfo) => {
    for (const egress of ["none", "open"] as const) {
      const fake = await fakeDocker({ serverInfo });
      const sandbox = await resolveSandbox({ runtime: { docker: fake.docker, egress, image: "node:24", kind: "container" } }, {});
      await expect(sandbox.open()).rejects.toThrow(/requires rootful Docker Engine on native Linux/);
      expect((await fake.calls()).map(call => call.argv[0])).toEqual(["version", "info"]);
    }
  });

  it.each(["none", "open"] as const)("accepts native Azure Linux with egress %s", async (egress) => {
    const fake = await fakeDocker({
      serverInfo: {
        KernelVersion: "6.6.112.1-1.azl3",
        OSType: "linux",
        OperatingSystem: "Microsoft Azure Linux 3.0",
        SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
      },
    });
    const sandbox = await resolveSandbox({ runtime: { docker: fake.docker, egress, image: "node:24", kind: "container" } }, {});
    const session = await sandbox.open();
    try {
      expect((await session.exec("true")).ok).toBe(true);
    } finally {
      await session.close();
    }
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
    expect(sandboxRun?.argv).toEqual(expect.arrayContaining(["--init", "--security-opt", "no-new-privileges:true", "--cap-drop", "NET_RAW"]));
    expect(sandboxRun?.argv[sandboxRun.argv.indexOf("--network") + 1]).toMatch(/-net$/);
    const network = calls.find(call => call.argv[0] === "network" && call.argv[1] === "create");
    expect(network?.argv).toEqual(expect.arrayContaining([
      "--internal", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "com.docker.network.bridge.gateway_mode_ipv6=isolated",
    ]));

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

  it.each(["kill", "abort"])("waits for PID registration on immediate %s", async (action) => {
    const fake = await fakeDocker({ processes: true });
    const session = await (await resolveSandbox({ runtime: { docker: fake.docker, image: "node:24", kind: "container" } }, {})).open();
    try {
      const controller = new AbortController();
      const child = await session.spawn!("sh", ["-c", "sleep 1; true"], { signal: controller.signal });
      if (action === "kill") await child.kill();
      else controller.abort();
      expect((await child.wait()).code).not.toBe(0);
      // Even abort must wait for the remote signal command, rather than only killing the CLI.
      const calls = await fake.calls();
      expect(calls.filter(call => call.argv[0] === "signal-result").at(-1)?.argv[1]).toBe("0");
    } finally {
      await session.close();
    }
  });

  it("waits for registration when exec is aborted immediately", async () => {
    const fake = await fakeDocker({ processes: true });
    const session = await (await resolveSandbox({ runtime: { docker: fake.docker, image: "node:24", kind: "container" } }, {})).open();
    try {
      const controller = new AbortController();
      const result = session.exec("sh", ["-c", "sleep 1; true"], { signal: controller.signal });
      controller.abort(new Error("cancel exec"));
      await expect(result).rejects.toThrow("cancel exec");
      expect((await fake.calls()).filter(call => call.argv[0] === "signal-result").at(-1)?.argv[1]).toBe("0");
    } finally {
      await session.close();
    }
  });

  it.each(["kill", "abort"])("reports a failed signal command on %s", async (action) => {
    const fake = await fakeDocker({ processes: true, failSignals: true });
    const session = await (await resolveSandbox({ runtime: { docker: fake.docker, image: "node:24", kind: "container" } }, {})).open();
    try {
      const controller = new AbortController();
      const child = await session.spawn!("sh", ["-c", "sleep 1; true"], { signal: controller.signal });
      if (action === "kill") {
        await expect(child.kill()).rejects.toThrow(/signal exec failed/);
        await child.wait();
      } else {
        controller.abort();
        await expect(child.wait()).rejects.toThrow(/signal exec failed/);
      }
    } finally {
      await session.close();
    }
  });
});

const dockerTests = process.env.VITEHUB_SANDBOX_DOCKER_TEST === "1";

/** Runs against a real Docker daemon. Set VITEHUB_SANDBOX_DOCKER_TEST=1 to enable. */
describe.skipIf(!dockerTests)("container Sandbox runtime with Docker", () => {
  const image = process.env.VITEHUB_SANDBOX_DOCKER_IMAGE || "node:24-bookworm";

  it.each(["none", "open"] as const)("blocks direct host services with egress %s", { timeout: 120_000 }, async (egress) => {
    const server = createServer(socket => socket.end("host-service"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "0.0.0.0", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing host listener address");
    let session: SandboxSession | undefined;
    try {
      session = await (await resolveSandbox({ runtime: { egress, image, kind: "container" } }, {})).open();
      const container = execFileSync("docker", ["ps", "--filter", "label=dev.vitehub.sandbox", "--format", "{{.Names}}"], { encoding: "utf8" })
        .trim().split("\n").find(name => !name.endsWith("-broker"))!;
      const network = execFileSync("docker", ["inspect", container, "--format", "{{range .NetworkSettings.Networks}}{{.NetworkID}}{{end}}"], { encoding: "utf8" }).trim();
      const subnet = execFileSync("docker", ["network", "inspect", network, "--format", "{{(index .IPAM.Config 0).Subnet}}"], { encoding: "utf8" }).trim();
      const gateway = subnet.split("/")[0]!.replace(/\.\d+$/, ".1");
      const defaultGateway = execFileSync("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { encoding: "utf8" }).trim();
      for (const host of new Set([gateway, defaultGateway, "host.docker.internal"])) {
        // Run against a local native Linux daemon so the listener shares the Docker host.
        // A TCP socket ignores every proxy environment variable.
        const result = await session.exec("node", ["-e", `
          const socket = require('node:net').connect(${address.port}, ${JSON.stringify(host)});
          socket.on('connect', () => process.exit(1));
          socket.on('error', () => process.exit(0));
          socket.setTimeout(2000, () => process.exit(0));
        `]);
        expect(result.code).toBe(0);
      }
    } finally {
      await session?.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

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

  it("allows an HTTPS IP address without a server name", { timeout: 120_000 }, async () => {
    const session = await (await resolveSandbox({ runtime: { egress: { allow: ["1.1.1.1"] }, image, kind: "container" } }, {})).open();
    try {
      const result = await session.exec("sh", ["-c", "curl -sS -o /dev/null -w '%{http_code}' https://1.1.1.1/"]);
      expect(result.stdout).not.toBe("403");
      expect(result.stdout).toMatch(/^[23]\d\d$/);
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

      const ssh = await session.exec("sh", ["-c", "curl -sS -m 5 --proxytunnel https://registry.npmjs.org:22; true"]);
      expect(`${ssh.stdout}${ssh.stderr}`).toContain("403");

      const host = await session.exec("sh", ["-c", "curl -sS -o /dev/null -w '%{http_code}' -H 'Host: example.com' -H \"Authorization: Bearer $NPM_TOKEN\" https://registry.npmjs.org/vite-hub"]);
      expect(host.stdout).toBe("403");
      const sni = await session.exec("sh", ["-c", "printf 'GET / HTTP/1.1\\r\\nHost: registry.npmjs.org\\r\\nConnection: close\\r\\n\\r\\n' | openssl s_client -quiet -proxy vitehub-broker:8080 -connect registry.npmjs.org:443 -servername example.com -CAfile /vitehub/broker-ca.pem 2>/dev/null | head -1"]);
      expect(sni.stdout).toContain("403");

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

      const sleeper = await session.spawn!("sh", ["-c", "sleep 301; true"]);
      await sleeper.kill();
      expect((await sleeper.wait()).code).not.toBe(0);
      expect((await session.exec("sh", ["-c", "ps -eo args | grep -c '[s]leep 301' || true"])).stdout.trim()).toBe("0");

      const controller = new AbortController();
      const aborted = await session.spawn!("sh", ["-c", "sleep 302; true"], { signal: controller.signal });
      controller.abort();
      expect((await aborted.wait()).code).not.toBe(0);
      expect((await session.exec("sh", ["-c", "ps -eo args | grep -c '[s]leep 302' || true"])).stdout.trim()).toBe("0");
    } finally {
      await session.close();
    }
    expect(execFileSync("docker", ["ps", "-aq", "--filter", "label=dev.vitehub.sandbox"], { encoding: "utf8" }).trim()).toBe("");
    expect(execFileSync("docker", ["network", "ls", "-q", "--filter", "label=dev.vitehub.sandbox"], { encoding: "utf8" }).trim()).toBe("");
  });
});
