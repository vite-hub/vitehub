import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { HarnessV1SandboxProvider } from "@ai-sdk/harness";
import { afterEach, describe, expect, it } from "vitest";

import { resolveBox, trustedHost } from "../src/index.ts";
import { materializeGitCheckout } from "../src/internal/git-checkout.ts";

const exec = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Box checkout", () => {
  it("materializes isolated exact Git revisions with private Home commit and push support", async () => {
    const root = await temporaryRoot();
    const repository = await createRepository(root);
    let resolutions = 0;
    const box = await resolveBox(
      {
        checkout: {
          ref: (context: typeof repository & { ref: string }) => (++resolutions, context.ref),
          remote: (context: typeof repository & { ref: string }) => (++resolutions, context.remote),
          sha: (context: typeof repository & { ref: string }) => (++resolutions, context.sha),
        },
        home: {
          files: {
            ".gitconfig": {
              contents: "[user]\n\tname = Box Agent\n\temail = box@example.com\n",
            },
          },
        },
        runtime: trustedHost(),
      },
      { ...repository, ref: "refs/heads/main" },
    );

    expect(resolutions).toBe(3);
    expect(box.workspace).toEqual({ state: "disposable", workDir: "workspace" });
    expect(JSON.stringify(box)).not.toContain(repository.remote);
    const sandbox = box.sandbox as HarnessV1SandboxProvider;
    const [first, second] = await Promise.all([sandbox.createSession(), sandbox.createSession()]);
    const firstWorkspace = join(first.defaultWorkingDirectory, "workspace");
    const secondWorkspace = join(second.defaultWorkingDirectory, "workspace");

    expect(firstWorkspace).not.toBe(secondWorkspace);
    expect(resolutions).toBe(3);
    for (const [session, workspace] of [
      [first, firstWorkspace],
      [second, secondWorkspace],
    ] as const) {
      await expect(
        session.run({ command: "git rev-parse HEAD", workingDirectory: workspace }),
      ).resolves.toMatchObject({ exitCode: 0, stdout: `${repository.sha}\n` });
      await expect(stat(join(workspace, ".git"))).resolves.toMatchObject({});
    }

    const change = await first.run({
      command:
        "printf changed > changed.txt && git add changed.txt && git commit --quiet -m change && git push --quiet origin HEAD:refs/heads/box-change",
      workingDirectory: firstWorkspace,
    });
    expect(change.exitCode).toBe(0);
    await expect(
      exec("git", ["--git-dir", repository.remote, "rev-parse", "box-change"]),
    ).resolves.toMatchObject({ stdout: expect.stringMatching(/^[0-9a-f]{40}\n$/) });

    const sessionRoots = [first.defaultWorkingDirectory, second.defaultWorkingDirectory];
    await Promise.all([first.destroy?.(), second.destroy?.()]);
    for (const sessionRoot of sessionRoots) {
      await expect(stat(sessionRoot)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("fails closed on revision mismatch and removes the partial checkout", async () => {
    const root = await temporaryRoot();
    const repository = await createRepository(root);
    const sessionTmp = join(root, "sessions");
    await mkdir(sessionTmp);
    const box = await resolveBox(
      {
        checkout: {
          ref: "refs/heads/main",
          remote: repository.remote,
          sha: "0".repeat(40),
        },
        runtime: trustedHost(),
      },
      {},
    );

    await withEnvironment({ TMPDIR: sessionTmp }, async () => {
      await expect((box.sandbox as HarnessV1SandboxProvider).createSession()).rejects.toThrow(
        `expected ${"0".repeat(40)}, received ${repository.sha}`,
      );
    });
    await expect(readdir(sessionTmp)).resolves.toEqual([]);
  });

  it("honors cancellation and removes the partial checkout", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    const sessionTmp = join(root, "sessions");
    await Promise.all([mkdir(bin), mkdir(sessionTmp)]);
    await executable(bin, "git", "trap 'exit 130' TERM INT\nwhile :; do sleep 0.05; done");
    const box = await resolveBox(
      {
        checkout: {
          ref: "refs/heads/main",
          remote: "https://example.com/repository.git",
          sha: "0".repeat(40),
        },
        runtime: trustedHost(),
      },
      {},
    );
    const abort = new AbortController();

    await withEnvironment({ PATH: bin, TMPDIR: sessionTmp }, async () => {
      const creating = (box.sandbox as HarnessV1SandboxProvider).createSession({
        abortSignal: abort.signal,
      });
      setTimeout(() => abort.abort(new Error("cancelled")), 25);
      await expect(creating).rejects.toThrow("cancelled");
    });
    await expect(readdir(sessionTmp)).resolves.toEqual([]);
  });

  it("treats invocation-controlled remotes and refs as positional Git arguments", async () => {
    const root = await temporaryRoot();
    const repository = await createRepository(root);
    const marker = join(root, "option-injection");
    const box = await resolveBox(
      {
        checkout: {
          ref: `--upload-pack=sh -c 'touch ${marker}'`,
          remote: repository.remote,
          sha: repository.sha,
        },
        runtime: trustedHost(),
      },
      {},
    );

    await expect((box.sandbox as HarnessV1SandboxProvider).createSession()).rejects.toThrow(
      "checkout failed to fetch ref",
    );
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    const commands: string[][] = [];
    await materializeGitCheckout(
      { ref: "--upload-pack=payload", remote: "--mirror=fetch", sha: "0".repeat(40) },
      "/workspace",
      {
        async run(args) {
          commands.push([...args]);
          return { stdout: args.includes("rev-parse") ? `${"0".repeat(40)}\n` : "" };
        },
      },
    );
    expect(commands[1]).toEqual([
      "-C",
      "/workspace",
      "remote",
      "add",
      "--",
      "origin",
      "--mirror=fetch",
    ]);
    expect(commands[2].slice(-3)).toEqual(["origin", "--", "--upload-pack=payload"]);
  });

  it("rejects cwd composition before resolving invocation values", async () => {
    let resolutions = 0;

    await expect(
      resolveBox(
        {
          checkout: {
            ref: () => (++resolutions, "refs/heads/main"),
            remote: () => (++resolutions, "https://example.com/repository.git"),
            sha: () => (++resolutions, "0".repeat(40)),
          },
          cwd: () => (++resolutions, process.cwd()),
          runtime: trustedHost(),
        },
        {},
      ),
    ).rejects.toThrow("checkout cannot be combined with cwd");
    expect(resolutions).toBe(0);
  });

  it("includes the resolved checkout in Box identity", async () => {
    const definition = (sha: string) => ({
      checkout: {
        ref: "refs/heads/main",
        remote: "https://example.com/repository.git",
        sha,
      },
      runtime: trustedHost(),
    });

    const first = await resolveBox(definition("0".repeat(40)), {});
    const same = await resolveBox(definition("0".repeat(40)), {});
    const changed = await resolveBox(definition("1".repeat(40)), {});

    expect(first.identity).toBe(same.identity);
    expect(first.identity).not.toBe(changed.identity);
  });
});

async function createRepository(root: string) {
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "--quiet", "--bare", remote]);
  await exec("git", ["init", "--quiet", "--initial-branch=main", seed]);
  await writeFile(join(seed, "README.md"), "initial\n");
  await exec("git", ["-C", seed, "add", "README.md"]);
  await exec("git", [
    "-C",
    seed,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "--quiet",
    "-m",
    "initial",
  ]);
  await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
  await exec("git", ["-C", seed, "push", "--quiet", "origin", "main"]);
  const sha = (await exec("git", ["-C", seed, "rev-parse", "HEAD"])).stdout.trim();
  return { remote, sha };
}

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-box-checkout-test-"));
  roots.push(root);
  return root;
}

async function executable(bin: string, name: string, body: string) {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

async function withEnvironment<T>(environment: Record<string, string>, run: () => Promise<T>) {
  const original = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
