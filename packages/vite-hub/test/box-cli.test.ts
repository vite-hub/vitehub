import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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
      expect(name).toBe("vitehub-box-check");
      expect(options.timeoutMs).toBe(25_000);
      return agentStatus.status;
    },
}));

const { createBoxCliNamespace } = await import("../src/box-cli.ts");

const run = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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
  const found = createBoxCliNamespace().features.find((item) => item.name === name);
  if (!found) throw new TypeError(`Missing box ${name}.`);
  return found;
}

describe("vitehub box", () => {
  it.each(["codex", "claude-code"])("uses supplied proxy settings only for %s", async (driver) => {
    vi.stubEnv("CLIPROXY_BASE_URL", "https://ambient.example/v1");
    vi.stubEnv("CLIPROXY_API_KEY", "ambient-key");
    const env = {
      CLIPROXY_BASE_URL: "https://supplied.example/v1",
      CLIPROXY_API_KEY: "supplied-key",
      CRABBOX_SSH_KEY: "/ssh/id_ed25519",
      CRABBOX_STATIC_USER: "agent",
    };
    await feature("check").run(["--driver", driver], context(env).context);
    if (driver === "codex") {
      expect(agentStatus.definitions.at(-1)).toMatchObject({
        driver: {
          env: { CLIPROXY_BASE_URL: env.CLIPROXY_BASE_URL, CLIPROXY_API_KEY: env.CLIPROXY_API_KEY },
        },
      });
      await feature("check").run(
        [],
        context({ ...env, CLIPROXY_BASE_URL: undefined, CLIPROXY_API_KEY: undefined }).context,
      );
      expect(agentStatus.definitions.at(-1)).toMatchObject({
        driver: { env: { CLIPROXY_BASE_URL: undefined, CLIPROXY_API_KEY: undefined } },
      });
    } else {
      expect(agentStatus.definitions.at(-1)).not.toHaveProperty("driver.env");
    }
  });

  it("serves SSH commands from env fallbacks and stops on SIGTERM", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-box-cli-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const hostKey = join(root, "host");
    const identity = join(root, "identity");
    await Promise.all(
      [hostKey, identity].map((path) =>
        run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]),
      ),
    );
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const serve = context({
      CRABBOX_STATIC_USER: "agent",
      RUNNER_WORKSPACE: root,
      SSH_AUTHORIZED_KEY: `${identity}.pub`,
      SSH_HOST_KEY: hostKey,
      SSH_PORT: String(port),
    });
    const running = Promise.resolve(feature("serve").run([], serve.context));
    await vi.waitFor(() => expect(serve.stdout()).toContain('"event":"box.listening"'), {
      timeout: 10_000,
    });
    expect(JSON.parse(serve.stdout())).toEqual({ event: "box.listening", port });

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
      event: "box.check",
      driver: "codex",
      installed: true,
      authenticated: false,
    });
    expect(agentStatus.definitions[0]).toMatchObject({
      driver: { kind: "codex", env: { CODEX_AUTH_JSON: "{}" } },
    });

    agentStatus.status = { ...agentStatus.status, authenticated: undefined };
    expect(await feature("check").run([], context(env).context)).toBe(1);
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
