import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import * as sandboxSsh from "@vite-hub/sandbox/ssh";
import type { ViteHubCliContext } from "@vite-hub/internal/cli";
import { afterEach, describe, expect, it, vi } from "vitest";

const agentStatus = vi.hoisted(() => ({
  definitions: [] as unknown[],
  status: {
    authenticated: false as boolean | undefined,
    installed: true,
    readiness: "unavailable",
    reason: "Provider is signed out.",
  },
}));

vi.mock("@vite-hub/agent", () => ({
  defineAgent: (definition: unknown) => {
    agentStatus.definitions.push(definition);
    return definition;
  },
}));

vi.mock("@vite-hub/agent/server", () => ({
  createAgentStatusReader:
    (options: { timeoutMs?: number }) => async (agent: unknown, name: string) => {
      expect(agent).toBe(agentStatus.definitions.at(-1));
      expect(name).toBe("vitehub-sandbox-check");
      expect(options.timeoutMs).toBe(25_000);
      return agentStatus.status;
    },
}));

const { createSandboxCliNamespace } = await import("../src/sandbox-cli.ts");

const run = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  agentStatus.definitions.length = 0;
});

function context(env: NodeJS.ProcessEnv, cwd = "/app") {
  let stdout = "";
  const value: ViteHubCliContext = {
    cwd,
    env,
    rootDir: cwd,
    spawn: async () => ({ exitCode: 0 }),
    stderr: { write: () => true },
    stdout: {
      write: (chunk) => {
        stdout += String(chunk);
        return true;
      },
    },
  };
  return { context: value, stdout: () => stdout };
}

function feature(name: "serve" | "check") {
  const found = createSandboxCliNamespace().features.find((item) => item.name === name);
  if (!found) throw new TypeError(`Missing sandbox ${name}.`);
  return found;
}

describe("vitehub sandbox", () => {
  it.each(["codex", "claude-code"])("uses supplied CLIProxyAPI settings for %s", async (driver) => {
    vi.stubEnv("CLIPROXY_URL", "https://ambient.example");
    vi.stubEnv("CLIPROXY_API_KEY", "ambient-key");
    const env = {
      CLIPROXY_URL: "https://supplied.example/v1",
      CLIPROXY_API_KEY: "supplied-key",
      CRABBOX_SSH_KEY: "/ssh/id_ed25519",
      CRABBOX_STATIC_USER: "agent",
    };
    await feature("check").run(["--driver", driver], context(env).context);
    expect(agentStatus.definitions.at(-1)).toMatchObject({
      driver: {
        gateway: {
          name: "cliproxy",
          apiKey: "supplied-key",
          baseURL: { codex: "https://supplied.example/v1", "claude-code": "https://supplied.example" },
        },
      },
    });
    await feature("check").run(
      ["--driver", driver],
      context({ ...env, CLIPROXY_URL: undefined, CLIPROXY_API_KEY: undefined }).context,
    );
    expect(agentStatus.definitions.at(-1)).not.toHaveProperty("driver.gateway");
  });

  it("serves SSH commands from env fallbacks and stops on SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-cli-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const hostKey = join(root, "host");
    const identity = join(root, "identity");
    await Promise.all(
      [hostKey, identity].map((path) =>
        run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]),
      ),
    );
    const serveSsh = sandboxSsh.serveSsh;
    const listener = vi.spyOn(sandboxSsh, "serveSsh").mockImplementation((options) =>
      serveSsh({ ...options, port: 0 }),
    );
    const serve = context({
      CRABBOX_STATIC_USER: "agent",
      RUNNER_WORKSPACE: root,
      SSH_AUTHORIZED_KEY: `${identity}.pub`,
      SSH_HOST_KEY: hostKey,
      SSH_PORT: "2222",
    });
    const running = Promise.resolve(feature("serve").run([], serve.context));
    await vi.waitFor(() => expect(serve.stdout()).toContain('"event":"sandbox.listening"'), {
      timeout: 10_000,
    });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ port: 2222 }));
    const { port } = JSON.parse(serve.stdout()) as { port: number };
    expect(port).toBeGreaterThan(0);
    expect(JSON.parse(serve.stdout())).toEqual({ event: "sandbox.listening", port });

    const { stdout } = await run("ssh", [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-i",
      identity,
      "-p",
      String(port),
      "agent@127.0.0.1",
      "pwd",
    ]);
    expect(stdout.trim()).toBe(root);

    process.emit("SIGTERM");
    expect(await running).toBe(0);
    expect(serve.stdout()).not.toContain("sandbox.draining");
  });

  it("drains open connections on SIGTERM with --drain-timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-sandbox-cli-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const hostKey = join(root, "host");
    const identity = join(root, "identity");
    await Promise.all(
      [hostKey, identity].map((path) =>
        run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]),
      ),
    );
    const serveSsh = sandboxSsh.serveSsh;
    vi.spyOn(sandboxSsh, "serveSsh").mockImplementation((options) =>
      serveSsh({ ...options, port: 0 }),
    );
    const serve = context({
      CRABBOX_STATIC_USER: "agent",
      RUNNER_WORKSPACE: root,
      SSH_AUTHORIZED_KEY: `${identity}.pub`,
      SSH_HOST_KEY: hostKey,
      VITEHUB_SANDBOX_DRAIN_TIMEOUT_MS: "10000",
    });
    let exitCode: number | undefined;
    const running = Promise.resolve(feature("serve").run([], serve.context)).then((code) => {
      exitCode = code;
      return code;
    });
    await vi.waitFor(() => expect(serve.stdout()).toContain('"event":"sandbox.listening"'), {
      timeout: 10_000,
    });
    const { port } = JSON.parse(serve.stdout()) as { port: number };

    // `cat` keeps the SSH connection open until its input ends.
    const session = spawn(
      "ssh",
      ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-i", identity, "-p", String(port), "agent@127.0.0.1", "cat"],
      { stdio: "pipe" },
    );
    let output = "";
    session.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    const sessionClosed = once(session, "close");
    session.stdin.write("ready\n");
    await vi.waitFor(() => expect(output).toBe("ready\n"), { timeout: 10_000 });

    process.emit("SIGTERM");
    await vi.waitFor(() => expect(serve.stdout()).toContain('"event":"sandbox.draining"'));
    const events = serve.stdout().trim().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(events.at(-1)).toEqual({ event: "sandbox.draining", connections: 1, timeoutMs: 10_000 });
    const refused = connect({ host: "127.0.0.1", port });
    const [error] = (await once(refused, "error")) as [NodeJS.ErrnoException];
    expect(error.code).toBe("ECONNREFUSED");
    session.stdin.write("still running\n");
    await vi.waitFor(() => expect(output).toBe("ready\nstill running\n"), { timeout: 10_000 });
    expect(exitCode).toBeUndefined();

    session.stdin.end();
    expect(await sessionClosed).toEqual([0, null]);
    expect(await running).toBe(0);
    expect(serve.stdout().trim().split("\n").at(-1)).toBe('{"event":"sandbox.closed"}');
  }, 30_000);

  it("rejects a --drain-timeout that is not a number of milliseconds", async () => {
    const env = { CRABBOX_STATIC_USER: "agent", SSH_AUTHORIZED_KEY: "/ssh/key.pub", SSH_HOST_KEY: "/ssh/host" };
    for (const value of ["-1", "1.5", "soon", "2147483648"]) {
      await expect(
        Promise.resolve(feature("serve").run([`--drain-timeout=${value}`], context(env).context)),
      ).rejects.toThrow("--drain-timeout must be a non-negative number of milliseconds");
    }
  });

  it("reports Driver readiness and fails only when the provider cannot start", async () => {
    const env = {
      CODEX_AUTH_JSON: "{}",
      CRABBOX_SSH_KEY: "/ssh/id_ed25519",
      CRABBOX_STATIC_USER: "agent",
      SSH_HOST_PUBLIC_KEY: "/ssh/host.pub",
    };
    const signedOut = context(env);
    expect(await feature("check").run(["--port", "2200"], signedOut.context)).toBe(0);
    expect(JSON.parse(signedOut.stdout())).toMatchObject({
      event: "sandbox.check",
      driver: "codex",
      installed: true,
      authenticated: false,
    });
    expect(agentStatus.definitions[0]).toMatchObject({
      driver: { kind: "codex", env: { CODEX_AUTH_JSON: "{}" } },
    });

    agentStatus.status = { ...agentStatus.status, authenticated: undefined };
    expect(await feature("check").run([], context(env).context)).toBe(1);
    // A gateway has no provider account, so a finished probe passes with unknown authentication.
    const gatewayEnv = { ...env, CLIPROXY_URL: "https://proxy.example", CLIPROXY_API_KEY: "key" };
    expect(await feature("check").run([], context(gatewayEnv).context)).toBe(1);
    agentStatus.status = { ...agentStatus.status, readiness: "unknown" };
    expect(await feature("check").run([], context(gatewayEnv).context)).toBe(0);
    agentStatus.status = { ...agentStatus.status, readiness: "unavailable" };
    agentStatus.status = { ...agentStatus.status, authenticated: true, installed: false };
    expect(await feature("check").run(["--driver", "claude-code"], context(env).context)).toBe(1);
    expect(agentStatus.definitions.at(-1)).not.toHaveProperty("driver.credentials");

    await expect(
      Promise.resolve(feature("check").run([], context({ CRABBOX_STATIC_USER: "agent" }).context)),
    ).rejects.toThrow("--identity-file or CRABBOX_SSH_KEY is required");
    await expect(
      Promise.resolve(feature("check").run(["--port", "0"], context(env).context)),
    ).rejects.toThrow("--port must be between 1 and 65535");
    await expect(
      Promise.resolve(feature("check").run(["--driver", "other"], context(env).context)),
    ).rejects.toThrow("--driver must be codex or claude-code");
  });
});
