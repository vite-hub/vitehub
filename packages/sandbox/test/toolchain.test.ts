import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSandbox, type SandboxRuntime } from "../src/index.ts";
import { openRemoteSandbox } from "../src/internal/remote.ts";
import type { RuntimeSession } from "../src/internal/session.ts";
import {
  nodeDistribution,
  normalizeToolchain,
  parsePackageManager,
  readToolchainPins,
  resolveNodeVersion,
} from "../src/internal/toolchain.ts";
import { createTrustedHostRuntime } from "../src/internal/trusted-host.ts";
import {
  fixtureNodeVersion,
  fixturePnpmVersion,
  fixtureYarnVersion,
  hostPlatformSuffix,
  startToolchainFixture,
  writeExecutable,
  writeProject,
} from "./toolchain-fixtures.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const project = normalizeToolchain("project")!;
let fixture: Awaited<ReturnType<typeof startToolchainFixture>> | undefined;

beforeEach(() => {
  vi.stubEnv("VITEHUB_NODE_DIST_URL", "http://127.0.0.1:9/unused");
  vi.stubEnv("VITEHUB_NPM_REGISTRY_URL", "http://127.0.0.1:9/unused");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fixture?.close();
  fixture = undefined;
  // Published toolchain entries are read-only.
  await Promise.all(roots.splice(0).map(async (root) => {
    await execFileAsync("chmod", ["-R", "u+w", root]).catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }));
});

async function useFixture(options?: Parameters<typeof startToolchainFixture>[0]) {
  fixture = await startToolchainFixture(options);
  for (const [name, value] of Object.entries(fixture.environment)) vi.stubEnv(name, value);
  return fixture;
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-toolchain-test-"));
  roots.push(root);
  return root;
}

const pinsFrom = (files: Record<string, string | object>, toolchain = project) => readToolchainPins(
  toolchain,
  Object.fromEntries(Object.entries(files).map(([path, value]) => [path, typeof value === "string" ? value : JSON.stringify(value)])),
);

describe("toolchain pins", () => {
  it("reads Node.js from project files in precedence order", () => {
    const all = {
      ".node-version": "v21.0.0\n",
      ".nvmrc": "lts/iron # team default\n",
      "package.json": {
        devEngines: { runtime: [{ name: "bun", version: "1.0.0" }, { name: "node", version: "^22.1.0" }] },
        engines: { node: ">=18" },
        volta: { node: "20.11.0" },
      },
    };
    expect(pinsFrom(all).node).toEqual({ source: "package.json#devEngines.runtime", version: "^22.1.0" });
    expect(pinsFrom({ ...all, "package.json": { devEngines: { runtime: { name: "node", version: "22" } } } }).node)
      .toEqual({ source: "package.json#devEngines.runtime", version: "22" });
    expect(pinsFrom({ ...all, "package.json": { engines: { node: ">=18" } } }).node).toEqual({ source: ".node-version", version: "v21.0.0" });
    expect(pinsFrom({ ".nvmrc": all[".nvmrc"], "package.json": { volta: { node: "20.11.0" } } }).node)
      .toEqual({ source: ".nvmrc", version: "lts/iron" });
    expect(pinsFrom({ "package.json": { engines: { node: ">=18" }, volta: { node: "20.11.0" } } }).node)
      .toEqual({ source: "package.json#volta.node", version: "20.11.0" });
    expect(pinsFrom({ "package.json": { engines: { node: ">=18 <21" } } }).node)
      .toEqual({ source: "package.json#engines.node", version: ">=18 <21" });
  });

  it("uses fallbackNode only when the project pins no Node.js version", () => {
    const toolchain = normalizeToolchain({ fallbackNode: "22" })!;
    expect(pinsFrom({ "package.json": {} }, toolchain).node).toEqual({ source: "toolchain.fallbackNode", version: "22" });
    expect(pinsFrom({ ".node-version": "20.1.0" }, toolchain).node).toEqual({ source: ".node-version", version: "20.1.0" });
    expect(() => pinsFrom({ "package.json": {} })).toThrow(expect.objectContaining({ code: "SANDBOX_R0147" }));
  });

  it("reads the package manager from packageManager or devEngines", () => {
    expect(pinsFrom({ ".node-version": "22", "package.json": { packageManager: "pnpm@10.2.0+sha512.ABC123" } }).packageManager).toEqual({
      integrity: "sha512.abc123",
      name: "pnpm",
      source: "package.json#packageManager",
      version: "10.2.0",
    });
    expect(pinsFrom({ ".node-version": "22", "package.json": { devEngines: { packageManager: { name: "yarn", version: "^4.1.0" } } } }).packageManager).toEqual({
      name: "yarn",
      source: "package.json#devEngines.packageManager",
      version: "^4.1.0",
    });
    expect(pinsFrom({ ".node-version": "22", "package.json": {} }).packageManager).toBeUndefined();
    expect(pinsFrom({ ".node-version": "22", "package.json": { packageManager: "pnpm@10.2.0" } }, normalizeToolchain({ packageManager: false })!).packageManager).toBeUndefined();
  });

  it("rejects unsupported declarations with diagnostics", () => {
    expect(() => parsePackageManager("bun@1.1.0", "package.json#packageManager")).toThrow(expect.objectContaining({ code: "SANDBOX_R0149" }));
    expect(() => parsePackageManager("pnpm", "package.json#packageManager")).toThrow(expect.objectContaining({ code: "SANDBOX_R0148" }));
    expect(() => pinsFrom({ "package.json": "{" })).toThrow(expect.objectContaining({ code: "SANDBOX_R0148" }));
    expect(() => normalizeToolchain({ node: "22", nodeVersion: "22" } as never)).toThrow(expect.objectContaining({ code: "SANDBOX_R0146" }));
    expect(() => normalizeToolchain({ packageManager: true } as never)).toThrow(expect.objectContaining({ code: "SANDBOX_R0146" }));
  });
});

describe("Node.js version resolution", () => {
  const platform = { arch: process.arch, libc: "glibc", os: process.platform === "darwin" ? "darwin" : "linux" } as const;

  it("resolves exact versions without the release index", async () => {
    const { count } = await useFixture();
    await expect(resolveNodeVersion("v20.11.1", platform)).resolves.toBe("20.11.1");
    expect(count("/dist/index.json")).toBe(0);
  });

  it("resolves ranges and aliases to the highest matching release", async () => {
    const { count } = await useFixture();
    await expect(resolveNodeVersion("22", platform)).resolves.toBe("22.2.0");
    await expect(resolveNodeVersion("^22.0.0 <22.2.0", platform)).resolves.toBe(fixtureNodeVersion);
    await expect(resolveNodeVersion(">=18 <22", platform)).resolves.toBe("20.5.0");
    await expect(resolveNodeVersion("lts/*", platform)).resolves.toBe("22.2.0");
    await expect(resolveNodeVersion("lts/iron", platform)).resolves.toBe("20.5.0");
    await expect(resolveNodeVersion("node", platform)).resolves.toBe("23.0.0");
    await expect(resolveNodeVersion("^19", platform)).rejects.toMatchObject({ code: "SANDBOX_R0151" });
    await expect(resolveNodeVersion("my-node", platform)).rejects.toMatchObject({ code: "SANDBOX_R0151" });
    expect(count("/dist/index.json")).toBe(1);
  });

  it("selects unofficial musl builds and honors mirrors", () => {
    const musl = nodeDistribution({ arch: "x64", libc: "musl", os: "linux" }, {});
    expect(musl.base).toBe("https://unofficial-builds.nodejs.org/download/release");
    expect(musl.file).toBe("linux-x64-musl");
    expect(musl.url("22.1.0", musl.archive("22.1.0"))).toBe("https://unofficial-builds.nodejs.org/download/release/v22.1.0/node-v22.1.0-linux-x64-musl.tar.gz");
    expect(musl.key("22.1.0")).toBe("node-v22.1.0-linux-x64-musl");
    const glibc = nodeDistribution({ arch: "arm64", libc: "glibc", os: "linux" }, { VITEHUB_NODE_DIST_URL: "https://mirror.example/node/" });
    expect(glibc.url("22.1.0", glibc.archive("22.1.0"))).toBe("https://mirror.example/node/v22.1.0/node-v22.1.0-linux-arm64.tar.gz");
    expect(nodeDistribution({ arch: "arm64", libc: "glibc", os: "darwin" }, {}).file).toBe("osx-arm64-tar");
  });
});

describe("trusted-host toolchain", () => {
  async function hostWithFakeNode(root: string) {
    const bin = join(root, "host-bin");
    await mkdir(bin);
    await writeExecutable(join(bin, "node"), ["#!/bin/sh", "echo v0.0.0-host"]);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  }

  it("provisions the project toolchain before host PATH entries", async () => {
    const { count } = await useFixture();
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await writeProject(workspace, {
      ".node-version": fixtureNodeVersion,
      "package.json": { packageManager: `pnpm@${fixturePnpmVersion}` },
    });
    await hostWithFakeNode(root);
    const stateRoot = join(root, "state");
    const sandbox = await resolveSandbox({
      cwd: workspace,
      runtime: createTrustedHostRuntime({ stateRoot }),
      toolchain: "project",
    }, {});
    expect(sandbox.plan.toolchain).toEqual({
      node: { source: ".node-version", version: fixtureNodeVersion },
      packageManager: { name: "pnpm", source: "package.json#packageManager", version: fixturePnpmVersion },
      source: "project",
    });
    expect(sandbox.plan.requirements.map(requirement => requirement.command)).toEqual(["node", "pnpm"]);

    const session = await sandbox.open();
    try {
      const node = await session.exec("sh", ["-c", "node -v && command -v node && pnpm --version && command -v pnpm"]);
      const cache = join(stateRoot, "toolchains");
      expect(node.stdout.trim().split("\n")).toEqual([
        `v${fixtureNodeVersion}`,
        join(cache, `node-v${fixtureNodeVersion}-${hostPlatformSuffix()}`, "bin", "node"),
        fixturePnpmVersion,
        join(cache, `pnpm-${fixturePnpmVersion}`, "bin", "pnpm"),
      ]);
      expect(session.toolchain).toEqual({
        bin: [join(cache, `pnpm-${fixturePnpmVersion}`, "bin"), join(cache, `node-v${fixtureNodeVersion}-${hostPlatformSuffix()}`, "bin")],
        node: { source: ".node-version", version: fixtureNodeVersion },
        packageManager: { name: "pnpm", source: "package.json#packageManager", version: fixturePnpmVersion },
      });
      // Published entries are read-only.
      await expect(writeFile(join(cache, `node-v${fixtureNodeVersion}-${hostPlatformSuffix()}`, "bin", "extra"), "")).rejects.toThrow();
    }
    finally {
      await session.close();
    }
    const reopened = await sandbox.open();
    await reopened.close();
    expect(count(`/dist/v${fixtureNodeVersion}/${fixture!.nodeArchive}`)).toBe(1);
    expect(count(`/registry/pnpm/-/pnpm-${fixturePnpmVersion}.tgz`)).toBe(1);
  });

  it("downloads once when concurrent sessions provision the same version", async () => {
    const { count } = await useFixture();
    const root = await temporaryRoot();
    await writeProject(join(root, "a"), { ".nvmrc": fixtureNodeVersion, "package.json": { packageManager: `pnpm@${fixturePnpmVersion}` } });
    await writeProject(join(root, "b"), { "package.json": { engines: { node: "~22.1.0" }, packageManager: `pnpm@${fixturePnpmVersion}` } });
    const runtime = createTrustedHostRuntime({ stateRoot: join(root, "state") });
    const sandboxes = await Promise.all(["a", "b"].map(async name => await resolveSandbox({ cwd: join(root, name), runtime, toolchain: "project" }, {})));
    expect(sandboxes.map(sandbox => sandbox.plan.toolchain?.node?.source)).toEqual([".nvmrc", "package.json#engines.node"]);
    const sessions = await Promise.all(sandboxes.map(async sandbox => await sandbox.open()));
    try {
      for (const session of sessions) {
        expect((await session.exec("node", ["-v"])).stdout.trim()).toBe(`v${fixtureNodeVersion}`);
        expect((await session.exec("pnpm", ["--version"])).stdout.trim()).toBe(fixturePnpmVersion);
      }
    }
    finally {
      await Promise.all(sessions.map(async session => await session.close()));
    }
    expect(count(`/dist/v${fixtureNodeVersion}/${fixture!.nodeArchive}`)).toBe(1);
    expect(count(`/registry/pnpm/-/pnpm-${fixturePnpmVersion}.tgz`)).toBe(1);
  });

  it("rejects a Node.js archive whose checksum does not match SHASUMS256.txt", async () => {
    await useFixture({ nodeChecksum: "0".repeat(64) });
    const root = await temporaryRoot();
    await writeProject(join(root, "project"), { ".node-version": fixtureNodeVersion });
    const sandbox = await resolveSandbox({
      cwd: join(root, "project"),
      runtime: createTrustedHostRuntime({ stateRoot: join(root, "state") }),
      toolchain: { packageManager: false },
    }, {});
    await expect(sandbox.open()).rejects.toMatchObject({ code: "SANDBOX_R0153", message: expect.stringContaining("checksum mismatch") });
  });

  it("verifies the Yarn bundle hash before publishing its toolchain", async () => {
    const { yarnSha512Hex } = await useFixture();
    const root = await temporaryRoot();
    const cwd = join(root, "project");
    const runtime = createTrustedHostRuntime({ stateRoot: join(root, "state") });
    await writeProject(cwd, { ".node-version": fixtureNodeVersion, "package.json": { packageManager: `yarn@${fixtureYarnVersion}+sha512.${yarnSha512Hex}` } });
    const sandbox = await resolveSandbox({ cwd, runtime, toolchain: "project" }, {});
    const session = await sandbox.open();
    try {
      expect((await session.exec("yarn", ["--version"])).stdout.trim()).toBe(fixtureYarnVersion);
    }
    finally {
      await session.close();
    }
    await writeProject(cwd, { "package.json": { packageManager: `yarn@${fixtureYarnVersion}+sha512.${"0".repeat(128)}` } });
    const invalid = await resolveSandbox({ cwd, runtime, toolchain: "project" }, {});
    await expect(invalid.open()).rejects.toMatchObject({ code: "SANDBOX_R0153", message: expect.stringContaining("package.json#packageManager") });
  });

  it("verifies registry integrity and the packageManager hash", async () => {
    await useFixture({ pnpmIntegrity: "sha512-AAAA" });
    const root = await temporaryRoot();
    await writeProject(join(root, "project"), { ".node-version": fixtureNodeVersion, "package.json": { packageManager: `pnpm@${fixturePnpmVersion}` } });
    const runtime = createTrustedHostRuntime({ stateRoot: join(root, "state") });
    const sandbox = await resolveSandbox({ cwd: join(root, "project"), runtime, toolchain: "project" }, {});
    await expect(sandbox.open()).rejects.toMatchObject({ code: "SANDBOX_R0153", message: expect.stringContaining("integrity mismatch") });

    await fixture!.close();
    const valid = await useFixture();
    await writeProject(join(root, "project"), { ".node-version": fixtureNodeVersion, "package.json": { packageManager: `pnpm@${fixturePnpmVersion}+sha512.${"0".repeat(128)}` } });
    const hashed = await resolveSandbox({ cwd: join(root, "project"), runtime, toolchain: "project" }, {});
    await expect(hashed.open()).rejects.toMatchObject({ code: "SANDBOX_R0153", message: expect.stringContaining("package.json#packageManager") });

    await writeProject(join(root, "project"), { ".node-version": fixtureNodeVersion, "package.json": { packageManager: `pnpm@${fixturePnpmVersion}+sha512.${valid.pnpmSha512Hex}` } });
    const matching = await resolveSandbox({ cwd: join(root, "project"), runtime, toolchain: "project" }, {});
    const session = await matching.open();
    expect((await session.exec("pnpm", ["--version"])).stdout.trim()).toBe(fixturePnpmVersion);
    await session.close();
  });

  it("reads pins from a checkout after it is materialized", async () => {
    await useFixture();
    const root = await temporaryRoot();
    const repository = join(root, "repository");
    await writeProject(repository, { ".node-version": fixtureNodeVersion, "package.json": { packageManager: `pnpm@${fixturePnpmVersion}` } });
    const git = async (...args: string[]) => (await execFileAsync("git", args, { cwd: repository })).stdout.trim();
    await git("init", "--quiet", "--initial-branch=main");
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "initial");
    const sha = await git("rev-parse", "HEAD");
    const sandbox = await resolveSandbox({
      checkout: { ref: "refs/heads/main", remote: repository, sha },
      runtime: createTrustedHostRuntime({ stateRoot: join(root, "state") }),
      toolchain: "project",
    }, {});
    expect(sandbox.plan.toolchain).toEqual({ source: "checkout" });
    expect(sandbox.plan.requirements.map(requirement => requirement.command)).toEqual(["git", "node"]);
    const session = await sandbox.open();
    try {
      expect(session.toolchain?.packageManager).toEqual({ name: "pnpm", source: "package.json#packageManager", version: fixturePnpmVersion });
      expect((await session.exec("pnpm", ["--version"])).stdout.trim()).toBe(fixturePnpmVersion);
    }
    finally {
      await session.close();
    }
  });

  it("fails clearly when a custom runtime ignores the toolchain", async () => {
    const root = await temporaryRoot();
    await writeProject(root, { ".node-version": fixtureNodeVersion });
    const close = vi.fn(async () => {});
    const runtime: SandboxRuntime = {
      name: "custom",
      async open() {
        return { close, cwd: "/", executionAuthority: undefined as never, exec: async () => ({ code: 0, ok: true, stderr: "", stdout: "" }), files: {} as never, id: "custom" };
      },
      async prepare(input) {
        return {
          cache: { state: "disposable" },
          environment: { env: {} },
          executionAuthority: { credentials: "none", environment: "selected", filesystem: { access: "none", scope: "sandbox" }, isolation: "container", network: "none", processes: "none" },
          identity: input.identity,
          requirements: [],
          runtime: "custom",
          workspace: { state: "disposable" },
        };
      },
    };
    const sandbox = await resolveSandbox({ cwd: root, runtime, toolchain: "project" }, {});
    await expect(sandbox.open()).rejects.toMatchObject({ code: "SANDBOX_R0156" });
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("remote toolchain", () => {
  async function localRemoteSession(root: string, basePath: string) {
    const env: Record<string, string> = {};
    const session: RuntimeSession = {
      defaultWorkingDirectory: join(root, "workspace"),
      id: "remote",
      async existsFile({ path }) {
        return await readFile(path).then(() => true, (error: NodeJS.ErrnoException) => error.code === "EISDIR");
      },
      async listFiles() { return []; },
      async makeDirectory({ path }) { await mkdir(path, { recursive: true }); },
      async readBinaryFile() { return null; },
      async removeFile({ path }) { await rm(path, { force: true, recursive: true }); },
      async run({ command, env: commandEnv, workingDirectory }) {
        try {
          const result = await execFileAsync("sh", ["-c", command], {
            cwd: workingDirectory,
            env: { HOME: join(root, "home"), PATH: basePath, ...env, ...commandEnv },
          });
          return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
        }
        catch (error) {
          const failure = error as { code: number; stderr: string; stdout: string };
          return { exitCode: failure.code, stderr: failure.stderr, stdout: failure.stdout };
        }
      },
      async stop() {},
      async writeBinaryFile({ content, path }) { await writeFile(path, content); },
    };
    return { env, session };
  }

  it("uploads the verified toolchain and reuses an exact image node", async () => {
    const { count } = await useFixture();
    const root = await temporaryRoot();
    const imageBin = join(root, "image-bin");
    await mkdir(imageBin);
    await writeExecutable(join(imageBin, "node"), [
      "#!/bin/sh",
      `case "$1" in -v) echo v${fixtureNodeVersion} ;; *) script=$1; shift; exec sh "$script" "$@" ;; esac`,
    ]);
    const basePath = `${imageBin}:/usr/bin:/bin`;
    const { env, session } = await localRemoteSession(root, basePath);
    const home = join(root, "home");
    const toolchain = normalizeToolchain({ node: fixtureNodeVersion, packageManager: `pnpm@${fixturePnpmVersion}` })!;
    const pins = readToolchainPins(toolchain, {});
    const sandbox = await openRemoteSandbox({
      identity: "remote",
      plan: { env: {}, files: {}, state: [] },
      requirements: [{ args: [], command: "pnpm", name: "pnpm" }],
      toolchain: { ...toolchain, pins },
    }, session, {
      executionAuthority: { credentials: "none", environment: "selected", filesystem: { access: "read-write", scope: "sandbox" }, isolation: "container", network: "unrestricted", processes: "arbitrary" },
      home,
      runtime: "test-remote",
      workspace: join(root, "workspace"),
    }, env);
    const pnpmBin = join(home, ".cache/vitehub/toolchains", `pnpm-${fixturePnpmVersion}`, "bin");
    expect(sandbox.toolchain).toEqual({
      bin: [pnpmBin],
      node: { source: "toolchain.node", version: fixtureNodeVersion },
      packageManager: { name: "pnpm", source: "toolchain.packageManager", version: fixturePnpmVersion },
    });
    expect(env.PATH).toBe(`${pnpmBin}:${basePath}`);
    expect((await sandbox.exec("pnpm", ["--version"])).stdout.trim()).toBe(fixturePnpmVersion);
    expect(count(`/dist/v${fixtureNodeVersion}/${fixture!.nodeArchive}`)).toBe(0);
    expect(count(`/registry/pnpm/-/pnpm-${fixturePnpmVersion}.tgz`)).toBe(1);
  });

  it("installs Node.js when the image node differs", async () => {
    await useFixture();
    const root = await temporaryRoot();
    const imageBin = join(root, "image-bin");
    await mkdir(imageBin);
    await writeExecutable(join(imageBin, "node"), ["#!/bin/sh", "echo v24.0.0"]);
    const { env, session } = await localRemoteSession(root, `${imageBin}:/usr/bin:/bin`);
    const toolchain = normalizeToolchain({ node: fixtureNodeVersion, packageManager: false })!;
    const sandbox = await openRemoteSandbox({
      identity: "remote",
      plan: { env: {}, files: {}, state: [] },
      requirements: [],
      toolchain: { ...toolchain, pins: readToolchainPins(toolchain, {}) },
    }, session, {
      executionAuthority: { credentials: "none", environment: "selected", filesystem: { access: "read-write", scope: "sandbox" }, isolation: "container", network: "unrestricted", processes: "arbitrary" },
      home: join(root, "home"),
      runtime: "test-remote",
      workspace: join(root, "workspace"),
    }, env);
    expect((await sandbox.exec("node", ["-v"])).stdout.trim()).toBe(`v${fixtureNodeVersion}`);
    expect(env.PATH?.split(":")[0]).toBe(join(root, "home/.cache/vitehub/toolchains", `node-v${fixtureNodeVersion}-${hostPlatformSuffix()}`, "bin"));
  });
});
