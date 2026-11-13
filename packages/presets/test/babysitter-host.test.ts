import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs/promises";
import { createBabysitterProcessHost, cleanupLegacyBabysitterCheckouts, ensureBabysitterLabels, readGitHubAppEnvironment } from "../src/babysitter/host.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename), readdir: vi.fn(original.readdir), lstat: vi.fn(original.lstat) };
});

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })));
});

it("removes the complete legacy checkout pool, including metadata sidecars", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-host-"));
  roots.push(dataDir);
  const pool = join(dataDir, "checkouts");
  await mkdir(join(pool, "repo-pr-42"), { recursive: true });
  await writeFile(join(pool, "repo-pr-42.meta.json"), "{}");
  await mkdir(join(pool, "another-pr"), { recursive: true });

  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).resolves.toBe(3);
  await expect(stat(pool)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).resolves.toBe(0);
  const quarantines = await fs.readdir(dataDir);
  expect(quarantines).toHaveLength(1);
  expect(await fs.readdir(join(dataDir, quarantines[0]!, "checkouts"))).toEqual([]);
});

it("normalizes escaped PEM newlines from host environment secrets", async () => {
  const { privateKey } = await import("node:crypto").then(({ generateKeyPairSync }) => generateKeyPairSync("rsa", { modulusLength: 2048 }));
  const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
  vi.stubEnv("VITEHUB_GITHUB_APP_ID", "123");
  vi.stubEnv("VITEHUB_GITHUB_INSTALLATION_ID", "456");
  vi.stubEnv("VITEHUB_GITHUB_APP_OWNER", "acme");
  vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY", pem.replaceAll("\n", "\\n"));

  await expect(readGitHubAppEnvironment()).resolves.toMatchObject({ appId: 123, installationId: 456, privateKey: pem });
});

it("names a missing webhook secret at startup with the App settings present", async () => {
  vi.stubEnv("VITEHUB_GITHUB_APP_ID", "123");
  vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY", "key");
  vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "");
  await expect(readGitHubAppEnvironment({}, { webhookSecret: true })).rejects.toMatchObject({ code: "PRESETS_BABYSITTER_ENV_MISSING", message: expect.stringContaining("without VITEHUB_GITHUB_WEBHOOK_SECRET.") });
  vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "secret");
  await expect(readGitHubAppEnvironment({}, { webhookSecret: true })).resolves.toMatchObject({ appId: 123 });
});

it("creates the filter labels that a repository lacks", async () => {
  const requests: string[] = [];
  const github = {
    async forge({ repository }: { repository?: string }) {
      if (repository === "acme/down") throw new Error("no installation");
      return {
        async request(method: string, path: string, { body }: { body: { name: string } }) {
          requests.push(`${method} ${path} ${body.name}`);
          if (body.name === "babysitter:skip" && repository === "acme/app") throw Object.assign(new Error("exists"), { status: 422 });
          return {};
        },
      };
    },
  } as unknown as Parameters<typeof ensureBabysitterLabels>[0];
  await expect(ensureBabysitterLabels(github, ["acme/app", "acme/other", "acme/down"], ["babysitter:skip"])).resolves.toEqual({
    created: ["acme/other:babysitter:skip"],
    failed: ["acme/down:babysitter:skip"],
  });
  expect(requests).toEqual(["POST /repos/acme/app/labels babysitter:skip", "POST /repos/acme/other/labels babysitter:skip"]);
});

it("refuses to remove a replaced or symlinked checkout root", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-host-safe-"));
  roots.push(dataDir);
  const target = await mkdtemp(join(tmpdir(), "vitehub-babysitter-target-"));
  roots.push(target);
  await symlink(target, join(dataDir, "checkouts"));

  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).rejects.toThrow(/unsafe Babysitter checkout pool/);
  await expect(stat(target)).resolves.toBeDefined();
});

it("cleans only the owning process host pool before reading credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-babysitter-layout-"));
  roots.push(root);
  const dataDir = join(root, ".vitehub/agents/reviewer");
  const pool = join(dataDir, "checkouts");
  const sibling = join(root, ".vitehub/agents/checkouts");
  await mkdir(pool, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(pool, "pr.meta.json"), "{}");
  await writeFile(join(sibling, "state.db"), "keep");
  vi.stubEnv("VITEHUB_GITHUB_APP_ID", "");
  vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY", "");
  vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY_PATH", "");
  vi.stubEnv("VITEHUB_GITHUB_WEBHOOK_SECRET", "");
  // Cleanup runs before credentials and before process state is accessed.
  await expect(createBabysitterProcessHost({
    agent: { options: { filter: { repository: { allow: ["acme/repo"] } }, concurrency: 1 } },
    dataDir,
  } as Parameters<typeof createBabysitterProcessHost>[0])).rejects.toMatchObject({
    code: "PRESETS_BABYSITTER_ENV_MISSING",
    message: expect.stringContaining("VITEHUB_GITHUB_APP_ID, VITEHUB_GITHUB_PRIVATE_KEY (or VITEHUB_GITHUB_PRIVATE_KEY_PATH), VITEHUB_GITHUB_WEBHOOK_SECRET"),
  });
  await expect(stat(pool)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(sibling, "state.db"), "utf8")).toBe("keep");
});

it("starts without a repository allow list and reaches the GitHub App setup", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-installations-"));
  roots.push(dataDir);
  vi.stubEnv("VITEHUB_GITHUB_APP_ID", "");
  vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY", "");
  vi.stubEnv("VITEHUB_GITHUB_PRIVATE_KEY_PATH", "");
  // Without `repository.allow` the host serves the App's installed repositories, so it needs the App, not a list.
  await expect(createBabysitterProcessHost({
    agent: { options: { filter: { repository: { deny: ["acme/private"] } }, concurrency: 1 } },
    dataDir,
  } as Parameters<typeof createBabysitterProcessHost>[0])).rejects.toMatchObject({ code: "PRESETS_BABYSITTER_ENV_MISSING", message: expect.stringContaining("VITEHUB_GITHUB_APP_ID") });
});

it("preserves a replacement swapped in before claiming the pool", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-race-"));
  roots.push(dataDir);
  const pool = join(dataDir, "checkouts");
  await mkdir(pool);
  const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let replacement = "";
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    await rename(from, join(dataDir, "original"));
    await mkdir(pool);
    await writeFile(join(pool, "keep"), "replacement");
    replacement = String(to);
    await rename(from, to);
  });
  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).rejects.toThrow("replaced Babysitter checkout pool");
  expect(await readFile(join(replacement, "keep"), "utf8")).toBe("replacement");
});

it("does not delete a new pool created after claiming the old pool", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-replacement-"));
  roots.push(dataDir);
  const pool = join(dataDir, "checkouts");
  await mkdir(pool);
  const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
    await rename(from, to);
    await mkdir(pool);
    await writeFile(join(pool, "keep"), "replacement");
  });
  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).resolves.toBe(0);
  expect(await readFile(join(pool, "keep"), "utf8")).toBe("replacement");
});

it("preserves a claimed pathname replaced after its identity check", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-claimed-race-"));
  roots.push(dataDir);
  await mkdir(join(dataDir, "checkouts"));
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let replacement = "";
  vi.mocked(fs.readdir).mockImplementationOnce(async (path, options) => {
    const entries = await original.readdir(path, options);
    replacement = String(path);
    await original.rename(path, join(dataDir, "original"));
    await mkdir(replacement);
    await writeFile(join(replacement, "keep"), "replacement");
    return entries;
  });

  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).rejects.toThrow("replaced Babysitter checkout pool");
  expect(await readFile(join(replacement, "keep"), "utf8")).toBe("replacement");
});

it("keeps deletion bound to the worker cwd if its pathname changes during enumeration", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-worker-race-"));
  roots.push(dataDir);
  await mkdir(join(dataDir, "checkouts", "old-checkout"), { recursive: true });
  await writeFile(join(dataDir, "checkouts", "old-checkout", "remove"), "old");
  const hook = join(dataDir, "swap.mjs");
  await writeFile(hook, `
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const readdir = fs.readdir;
    fs.readdir = async (...args) => {
      const entries = await readdir(...args);
      if (args[0] === ".") {
        const claimed = process.cwd();
        await fs.rename(claimed, claimed + "-original");
        await fs.mkdir(claimed);
        await fs.writeFile(claimed + "/keep", "replacement");
      }
      return entries;
    };
    syncBuiltinESMExports();
  `);
  vi.stubEnv("NODE_OPTIONS", `--import=${pathToFileURL(hook).href}`);

  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).rejects.toThrow("replaced Babysitter checkout pool");
  const quarantine = (await fs.readdir(dataDir)).find(name => name.startsWith(".checkouts-cleanup-"))!;
  expect(await readFile(join(dataDir, quarantine, "checkouts", "keep"), "utf8")).toBe("replacement");
  expect(await fs.readdir(join(dataDir, quarantine, "checkouts-original"))).toEqual([]);
});

it("preserves an empty replacement introduced after the final identity check", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vitehub-babysitter-final-race-"));
  roots.push(dataDir);
  await mkdir(join(dataDir, "checkouts"));
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let checks = 0;
  let replacement = "";
  vi.mocked(fs.lstat).mockImplementation(async (path, options) => {
    const info = await original.lstat(path, options);
    if (++checks === 3) {
      replacement = String(path);
      await original.rename(path, join(dataDir, "original"));
      await mkdir(replacement);
    }
    return info;
  });

  await expect(cleanupLegacyBabysitterCheckouts(dataDir)).resolves.toBe(0);
  expect(checks).toBe(3);
  expect((await stat(replacement)).isDirectory()).toBe(true);
  expect(await fs.readdir(replacement)).toEqual([]);
});
