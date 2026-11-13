import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubHost } from "../src/github/index.ts";
import { defineAgent } from "@vite-hub/agent";
import { babysitter } from "../src/babysitter.ts";
import { createPullRequestWorkspaces, providerSessionDecision, workspaceDecision, type PullRequestWorkspaceEntry, type PullRequestWorkspaceRecord } from "../src/babysitter/pr-workspaces.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd })).stdout.trim();
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** A base repository and a fork with one PR branch, reached through https://github.com URLs. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-pr-workspaces-"));
  roots.push(root);
  const base = join(root, "base.git");
  const fork = join(root, "fork.git");
  const source = join(root, "source");
  await mkdir(source);
  await git(root, "init", "--bare", base);
  await git(root, "init", "--bare", fork);
  await git(source, "init", "-b", "main");
  await writeFile(join(source, ".gitignore"), "node_modules\n");
  await writeFile(join(source, "file"), "base");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "base");
  await git(source, "push", base, "HEAD:refs/heads/main");
  await git(source, "checkout", "-b", "fix");
  await writeFile(join(source, "file"), "pr");
  await git(source, "commit", "-am", "pr");
  await git(source, "push", fork, "HEAD:refs/heads/fix");
  const config = join(root, "gitconfig");
  await writeFile(config, "");
  await git(root, "config", "--file", config, `url.file://${base}.insteadOf`, "https://github.com/acme/app.git");
  await git(root, "config", "--file", config, `url.file://${fork}.insteadOf`, "https://github.com/contributor/app.git");
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
  const github = createGitHubHost({ credentials: () => ({ token: "test-token" }) });
  const workspaces = createPullRequestWorkspaces({ root: join(root, "data", "pr-workspaces") });
  /** One pass as the Babysitter runs it: lock, decide, check out, prepare, then record. */
  const pass = async (head: string, work: (entry: PullRequestWorkspaceEntry, push: (target: string) => Promise<string>) => Promise<Partial<PullRequestWorkspaceRecord> | void>, record = true) => {
    const entry = await workspaces.acquire("acme/app", 12);
    try {
      const plan = workspaceDecision(entry.previous, head, entry.existed);
      const { result, left } = await github.withPullRequestCheckout({ repository: "acme/app", number: 12, headSha: head, headRepository: "contributor/app", headRef: "fix" }, async (prepared) => {
        const result = await prepared.prepareWorkspace(entry.work, { reuse: plan.reuse, reason: plan.reason });
        expect(await git(entry.work, "rev-parse", "HEAD")).toBe(head);
        return { result, left: await work(entry, target => prepared.push(target)) };
      }, { persistent: { checkout: entry.checkout, work: entry.work } });
      if (record) await entry.record({ head, ok: true, ...left });
      if (!result) throw new Error("Expected a kept workspace result.");
      return { ...result, entry };
    } finally {
      await entry.release();
    }
  };
  const install = async (work: string) => {
    await mkdir(join(work, "node_modules", "dep"), { recursive: true });
    await writeFile(join(work, "node_modules", "dep", "index.js"), "kept");
    await writeFile(join(work, ".git", "vitehub-install.json"), JSON.stringify({ status: "installed" }));
    await mkdir(join(work, ".git", "vitehub-install-home", "store"), { recursive: true });
    await writeFile(join(work, ".git", "vitehub-install-home", "store", "package"), "cached");
  };
  /** Pushes to the fork from outside the Babysitter, like a person or a bot. */
  const foreignPush = async (content: string) => {
    await writeFile(join(source, "file"), content);
    await git(source, "commit", "-am", content);
    await git(source, "push", "--force", fork, "HEAD:refs/heads/fix");
    return await git(source, "rev-parse", "HEAD");
  };
  return { root, fork, workspaces, pass, install, foreignPush, head: await git(source, "rev-parse", "HEAD") };
}

describe("Babysitter PR workspaces", () => {
  it("keeps the workspace, its dependencies and the host clone on the head the previous pass pushed", async () => {
    const f = await fixture();
    const first = await f.pass(f.head, async (entry, push) => {
      await f.install(entry.work);
      await writeFile(join(entry.work, "file"), "repaired");
      await git(entry.work, "commit", "-am", "repair");
      return { head: await push(entry.work) };
    });
    expect([first.reused, first.reason]).toEqual([false, "cold"]);
    const pushed = await git(f.root, "--git-dir", f.fork, "rev-parse", "refs/heads/fix");
    expect(pushed).not.toBe(f.head);
    await writeFile(join(first.entry.checkout, ".git", "clone-marker"), "");
    const second = await f.pass(pushed, async (entry) => {
      expect(await readFile(join(entry.work, "node_modules", "dep", "index.js"), "utf8")).toBe("kept");
      expect(JSON.parse(await readFile(join(entry.work, ".git", "vitehub-install.json"), "utf8")).status).toBe("installed");
      expect(await readFile(join(entry.work, "file"), "utf8")).toBe("repaired");
    });
    expect([second.reused, second.reason]).toEqual([true, "warm"]);
    // The host clone was fetched again, not cloned.
    expect(existsSync(join(second.entry.checkout, ".git", "clone-marker"))).toBe(true);
    const third = await f.pass(pushed, async () => {});
    expect([third.reused, third.reason]).toEqual([true, "warm"]);
  });

  it("resets the workspace on a head that someone else pushed but keeps the package store", async () => {
    const f = await fixture();
    await f.pass(f.head, async entry => { await f.install(entry.work); });
    const foreign = await f.foreignPush("bot merge");
    const next = await f.pass(foreign, async (entry) => {
      expect(existsSync(join(entry.work, "node_modules"))).toBe(false);
      expect(existsSync(join(entry.work, ".git", "vitehub-install.json"))).toBe(false);
      expect(await readFile(join(entry.work, "file"), "utf8")).toBe("bot merge");
      expect(await readFile(join(entry.work, ".git", "vitehub-install-home", "store", "package"), "utf8")).toBe("cached");
    });
    expect([next.reused, next.reason]).toEqual([false, "foreign-head"]);
  });

  it("resets the workspace after a failed pass and after a pass that never recorded its result", async () => {
    const f = await fixture();
    await f.pass(f.head, async entry => { await f.install(entry.work); return { ok: false }; });
    const failed = await f.pass(f.head, async entry => { expect(existsSync(join(entry.work, "node_modules"))).toBe(false); });
    expect([failed.reused, failed.reason]).toEqual([false, "failed-pass"]);
    await f.pass(f.head, async entry => { await f.install(entry.work); });
    // A crash or an OOM kill ends the pass without a record. Its dependencies may be half-written.
    await f.pass(f.head, async entry => {
      await writeFile(join(entry.work, "node_modules", "dep", "index.js"), "incomplete");
    }, false);
    const crashed = await f.pass(f.head, async entry => { expect(existsSync(join(entry.work, "node_modules"))).toBe(false); });
    expect([crashed.reused, crashed.reason]).toEqual([false, "failed-pass"]);
  });

  it("resets a dirty tree and drops everything a pass left in .git", async () => {
    const f = await fixture();
    await f.pass(f.head, async (entry) => {
      await f.install(entry.work);
      await writeFile(join(entry.work, "file"), "uncommitted");
      await git(entry.work, "config", "credential.helper", "leak");
      await mkdir(join(entry.work, ".git", "hooks"), { recursive: true });
      await writeFile(join(entry.work, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    });
    const next = await f.pass(f.head, async (entry) => {
      expect(await readFile(join(entry.work, "file"), "utf8")).toBe("pr");
      expect(existsSync(join(entry.work, "node_modules"))).toBe(false);
      expect(existsSync(join(entry.work, ".git", "hooks", "pre-commit"))).toBe(false);
      expect(await readFile(join(entry.work, ".git", "config"), "utf8")).not.toContain("leak");
    });
    expect([next.reused, next.reason]).toEqual([false, "dirty"]);
  });

  it("removes terminal, unknown, idle and over-budget entries but keeps one a pass holds", async () => {
    let now = Date.now();
    const root = await mkdtemp(join(tmpdir(), "vitehub-pr-workspaces-sweep-"));
    roots.push(root);
    const workspaces = createPullRequestWorkspaces({ root, idleDays: 1, budgetGb: 0, now: () => now });
    for (const number of [1, 2, 3, 4]) {
      const entry = await workspaces.acquire("acme/app", number);
      await writeFile(join(entry.work, "file"), "x");
      await entry.record({ head: "a".repeat(40), ok: true });
      await entry.release();
    }
    const held = await workspaces.acquire("acme/app", 4);
    now += 2 * 24 * 60 * 60_000;
    const status = async (_repository: string, number: number) => number === 1 ? "terminal" as const : number === 2 ? "unknown" as const : "open" as const;
    const result = await workspaces.sweep(status);
    expect(result.removed.map(entry => [entry.name, entry.reason]).sort()).toEqual([["acme+app+1", "terminal"], ["acme+app+2", "unknown"], ["acme+app+3", "idle"]]);
    expect(existsSync(join(root, "acme+app+4", "work", "file"))).toBe(true);
    await held.release();
    now -= 2 * 24 * 60 * 60_000;
    expect((await workspaces.sweep(status)).removed).toEqual([{ name: "acme+app+4", reason: "budget" }]);
  });

  it("continues the provider thread only after a warm pass that pushed or waited on the same base and release", () => {
    const previous = { head: "a", base: "b", ok: true, resumable: true, release: "1", session: "run-1" };
    expect(providerSessionDecision(previous, "warm", { base: "b", release: "1" })).toEqual({ resume: true, reason: "resumed" });
    expect(providerSessionDecision(previous, "dirty", { base: "b", release: "1" })).toEqual({ resume: false, reason: "workspace-dirty" });
    expect(providerSessionDecision({ ...previous, resumable: false }, "warm", { base: "b", release: "1" })).toEqual({ resume: false, reason: "unfinished-pass" });
    expect(providerSessionDecision(previous, "warm", { base: "c", release: "1" })).toEqual({ resume: false, reason: "base-moved" });
    expect(providerSessionDecision(previous, "warm", { base: "b", release: "2" })).toEqual({ resume: false, reason: "new-release" });
  });

  it("validates warmWorkspaces", () => {
    expect(() => defineAgent({ extends: babysitter, options: { warmWorkspaces: { resumeThreads: true, budgetGb: 10 } } })).not.toThrow();
    for (const warmWorkspaces of [{ budgetGb: -1 }, { resumeThreads: "yes" }, { minFreePercent: 101 }, { unknown: 1 }]) {
      // SAFETY: invalid values on purpose.
      expect(() => defineAgent({ extends: babysitter, options: { warmWorkspaces: warmWorkspaces as never } })).toThrow(/warmWorkspaces must be/);
    }
  });
});
