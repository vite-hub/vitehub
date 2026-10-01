import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const sshModule = new URL("../../box/dist/ssh.js", import.meta.url).href;

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe("box check across separate application and runner environments", () => {
  it("uses runner paths and removes its private credential home", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-box-remote-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const runnerHome = join(root, "runner-home");
    const runnerTmp = join(root, "runner-tmp");
    const runnerBin = join(root, "runner-bin");
    const applicationTmp = join(root, "application-tmp");
    const runnerCodexHome = join(runnerHome, ".codex");
    const observations = join(root, "observations.jsonl");
    await Promise.all(
      [runnerHome, runnerTmp, runnerBin, applicationTmp].map((path) => mkdir(path)),
    );
    // Login shells read this after the system profile, which may replace PATH.
    await writeFile(join(runnerHome, ".profile"), `export PATH='${runnerBin}':"$PATH"\n`);
    await writeFile(
      join(runnerBin, "codex"),
      `#!${process.execPath}\n${String.raw`
const fs = require("node:fs")
const path = require("node:path")
const readline = require("node:readline")
const home = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex")
const authFile = path.join(home, "auth.json")
const auth = fs.existsSync(authFile) ? fs.readFileSync(authFile, "utf8") : undefined
fs.appendFileSync(process.env.PROBE_OBSERVATIONS, JSON.stringify({
  cwd: process.cwd(), home, auth,
  credentialEnvironment: process.env.CODEX_AUTH_JSON,
  directoryMode: fs.statSync(process.cwd()).mode & 0o777,
  authMode: auth ? fs.statSync(authFile).mode & 0o777 : undefined,
  config: auth ? fs.readFileSync(path.join(home, "config.toml"), "utf8") : undefined,
}) + "\n")
const lines = readline.createInterface({ input: process.stdin })
lines.on("line", line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const results = {
    initialize: { userAgent: "codex/1.0.0", codexHome: home, platformFamily: "unix", platformOs: "linux" },
    "account/read": { account: auth ? { type: "apiKey" } : null, requiresOpenaiAuth: true },
    "skills/list": { data: [] },
    "model/list": { data: [], nextCursor: null },
    "account/rateLimits/read": { rateLimits: {} },
  }
  process.stdout.write(JSON.stringify({ id: request.id, result: results[request.method] }) + "\n")
})
`}`,
      { mode: 0o700 },
    );
    const hostKey = join(root, "host");
    const identity = join(root, "identity");
    await Promise.all(
      [hostKey, identity].map((path) =>
        run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]),
      ),
    );
    const serverSource = `import { serveSsh } from ${JSON.stringify(sshModule)}
const server = await serveSsh(${JSON.stringify({ authorizedKeyFile: `${identity}.pub`, hostKeyFile: hostKey, cwd: runnerHome, user: "agent", port: 0 })})
console.log(server.port)
process.once("SIGTERM", async () => { await server.close(); process.exit(0) })
`;
    const server = spawn(process.execPath, ["--input-type=module", "-e", serverSource], {
      env: {
        ...process.env,
        HOME: runnerHome,
        CODEX_HOME: runnerCodexHome,
        CODEX_AUTH_JSON: "",
        TMPDIR: runnerTmp,
        PATH: `${runnerBin}:${process.env.PATH}`,
        PROBE_OBSERVATIONS: observations,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    cleanup.push(async () => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    });
    const lines = createInterface({ input: server.stdout });
    const [port] = await once(lines, "line");
    lines.close();
    const credentials = JSON.stringify({ OPENAI_API_KEY: "synthetic-test-key" });
    const args = [
      bin,
      "box",
      "check",
      "--user",
      "agent",
      "--identity-file",
      identity,
      "--host-key-file",
      `${hostKey}.pub`,
      "--port",
      String(port),
    ];
    const appEnv = {
      ...process.env,
      HOME: join(root, "missing-application-home"),
      CODEX_HOME: join(root, "missing-application-codex-home"),
      TMPDIR: applicationTmp,
      CODEX_AUTH_JSON: "",
      CLIPROXY_BASE_URL: "",
    };
    const signedOut = await run(process.execPath, args, {
      cwd: root,
      env: appEnv,
      timeout: 20_000,
    });
    expect(JSON.parse(signedOut.stdout)).toMatchObject({
      event: "box.check",
      installed: true,
      authenticated: false,
    });
    const signedIn = await run(process.execPath, args, {
      cwd: root,
      env: { ...appEnv, CODEX_AUTH_JSON: credentials },
      timeout: 20_000,
    });
    expect(JSON.parse(signedIn.stdout)).toMatchObject({
      event: "box.check",
      installed: true,
      authenticated: true,
    });
    const [withoutCredentials, withCredentials] = (await readFile(observations, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(withoutCredentials).toMatchObject({ home: runnerCodexHome, directoryMode: 0o700 });
    expect(withoutCredentials).not.toHaveProperty("auth");
    expect(withCredentials).toMatchObject({
      auth: credentials,
      directoryMode: 0o700,
      authMode: 0o600,
      config: 'cli_auth_credentials_store = "file"\n',
    });
    expect(withCredentials).not.toHaveProperty("credentialEnvironment");
    for (const observation of [withoutCredentials, withCredentials]) {
      expect(observation.cwd.startsWith(`${runnerTmp}/vitehub-box-check.`)).toBe(true);
      await expect(stat(observation.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(withCredentials.home).toBe(join(withCredentials.cwd, "codex"));
    await expect(stat(runnerCodexHome)).rejects.toMatchObject({ code: "ENOENT" });
  }, 45_000);
});
