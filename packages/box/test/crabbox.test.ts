import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"

import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveBox } from "../src/index.ts"
import { createCrabboxRuntime, pruneWorkspaceForArchive, rejectSymlinkedArchiveParents } from "../src/internal/crabbox.ts"
import { boxProvider } from "./helpers.ts"

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("createCrabboxRuntime", () => {
  it("resolves a provider-neutral Box without serializing its runtime bridge", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    await mkdir(workspace)

    const box = await resolveBox({
      runtime: createCrabboxRuntime({ profile: "babysitter" }),
      requires: [{ command: "gh", args: ["auth", "status"], timeout: 5_000 }, "pnpm"],
      cwd: ({ worktree }: { worktree: string }) => worktree,
    }, { worktree: workspace }, { requires: [
          { command: "codex", args: ["login", "status"] },
          { command: "gh", args: ["auth", "status"], timeout: 5_000 },
        ],
      },
    );

    expect(box.plan).toMatchObject({
      cache: { state: "disposable" },
      environment: {},
      executionAuthority: {
        credentials: "unknown",
        environment: "selected",
        filesystem: { access: "read-write", scope: "host" },
        isolation: "none",
        network: "unrestricted",
        processes: "arbitrary",
      },
      runtime: "crabbox",
      requirements: [
        { command: "gh", name: "gh auth status", timeout: 5_000 },
        { command: "pnpm", name: "pnpm" },
        { command: "codex", name: "codex login status" },
      ],
      workspace: { path: await realpath(workspace), state: "authoritative" },
    })
    expect(box.open).toBeTypeOf("function")
    expect(JSON.stringify(box)).not.toContain("sandbox")
  })

  it("materializes a disposable exact Git checkout without workspace synchronization", async () => {
    const root = await temporaryRoot()
    const repository = join(root, "repository")
    const bin = join(root, "bin")
    const log = join(root, "crabbox.log")
    await Promise.all([mkdir(repository), mkdir(bin)])
    await fakeCrabbox(bin)
    await runGit(repository, ["init", "--initial-branch=main"])
    await writeFile(join(repository, "README.md"), "checkout\n")
    await runGit(repository, ["add", "README.md"])
    await runGit(repository, [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.com",
      "commit", "-m", "initial",
    ])
    const sha = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()

    await withEnvironment(
      { CRABBOX_TEST_LOG: log, PATH: `${bin}:${process.env.PATH || ""}` },
      async () => {
        const box = await resolveBox({
          checkout: { ref: "refs/heads/main", remote: repository, sha },
          runtime: createCrabboxRuntime({ profile: "babysitter" }),
        }, {})
        expect(box.plan.workspace).toEqual({ state: "disposable", workDir: "workspace" })
        const session = await boxProvider(box).createSession()
        const sessionRoot = dirname(session.defaultWorkingDirectory)
        await expect(session.run({
          command: "git rev-parse HEAD",
          workingDirectory: join(sessionRoot, "workspace"),
        })).resolves.toMatchObject({ exitCode: 0, stdout: `${sha}\n` })
        await expect(session.run({
          command: [
            "git config user.name Fixture",
            "git config user.email fixture@example.com",
            "printf 'pushed from Crabbox\\n' > CHANGELOG.md",
            "git add CHANGELOG.md",
            "git commit -m update",
            "git push origin HEAD:refs/heads/crabbox-test",
          ].join(" && "),
          workingDirectory: join(sessionRoot, "workspace"),
        })).resolves.toMatchObject({ exitCode: 0 })
        await session.destroy?.()
        await expect(stat(sessionRoot)).rejects.toMatchObject({ code: "ENOENT" })

        const pushed = (await execFileAsync(
          "git",
          ["-C", repository, "rev-parse", "refs/heads/crabbox-test"],
        )).stdout.trim()
        expect(pushed).not.toBe(sha)

        const invocations = await readFile(log, "utf8")
        expect(invocations).toContain("--no-sync")
        expect(invocations.split("\n").filter(invocation => invocation.includes("|cp|"))).toHaveLength(1)
      },
    )
  }, 30_000)

  it("removes a disposable checkout with read-only nested content when closed", async () => {
    const root = await temporaryRoot()
    const repository = join(root, "repository")
    const bin = join(root, "bin")
    await Promise.all([mkdir(repository), mkdir(bin)])
    await fakeCrabbox(bin)
    await runGit(repository, ["init", "--initial-branch=main"])
    await writeFile(join(repository, "README.md"), "checkout\n")
    await runGit(repository, ["add", "README.md"])
    await runGit(repository, [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.com",
      "commit", "-m", "initial",
    ])
    const sha = (await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim()

    await withEnvironment({ PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({
        checkout: { ref: "refs/heads/main", remote: repository, sha },
        runtime: createCrabboxRuntime({ profile: "babysitter" }),
      }, {})
      const session = await box.open()
      expect(session.inspectionConcurrency).toBe(1)
      const sessionRoot = dirname(session.cwd)
      await expect(session.exec("sh", ["-c", "mkdir read-only && touch read-only/file && chmod 400 read-only/file && chmod 500 read-only"], {
        cwd: session.cwd,
      })).resolves.toMatchObject({ code: 0 })

      await session.close()

      await expect(stat(sessionRoot)).rejects.toMatchObject({ code: "ENOENT" })
    })
  }, 30_000)

  it.skipIf(process.platform !== "linux")("reclaims only reparented processes owned by the disposable root", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({ PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({ runtime: createCrabboxRuntime({ profile: "babysitter" }), cwd: workspace }, {})
      const session = await boxProvider(box).createSession()
      const spawnOrphan = async (argument: string, cwd?: string, boxRoot?: string) => {
        const result = await session.run({
          command: `node -e 'const { spawn } = require("node:child_process"); const cwd = process.argv[2] || undefined; const env = { PATH: process.env.PATH, PWD: cwd || "/", ...(process.argv[3] ? { BOX_ROOT: process.argv[3] } : {}) }; const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)", process.argv[1]], { cwd, detached: true, env, stdio: "ignore" }); child.unref(); console.log(child.pid)' '${argument}' '${cwd || ""}' '${boxRoot || ""}'`,
        })
        expect(result.exitCode).toBe(0)
        return Number(result.stdout.trim())
      }
      const ownedPid = await spawnOrphan(`${session.root}/owned`)
      const cwdOwnedPid = await spawnOrphan("unmarked", session.root)
      await session.run({ command: `mkdir -p -- '${session.root}.other'` })
      const envOwnedPid = await spawnOrphan("unmarked", `${session.root}.other`, session.root)
      const fdTree = await session.run({
        command: `node -e 'const { openSync } = require("node:fs"); const { spawn } = require("node:child_process"); const fd = openSync(process.argv[1], "a"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { cwd: process.argv[2], detached: true, env: { PATH: process.env.PATH, PWD: process.argv[2] }, stdio: ["ignore", "ignore", "ignore", fd] }); child.unref(); console.log(child.pid)' '${session.root}/fd-owned' '${session.root}.other'`,
      })
      const fdOwnedPid = Number(fdTree.stdout.trim())
      const commandOwnedPid = await spawnOrphan(`sleep 5; echo x >> ${session.root}/late-write`, `${session.root}.other`)
      const treePidFile = `${session.root}/tree-child.pid`
      const tree = await session.run({
        command: `node -e 'const { spawn } = require("node:child_process"); const child = spawn(process.execPath, ["-e", "const { spawn } = require(\\"node:child_process\\"); const child = spawn(process.execPath, [\\"-e\\", \\"setInterval(() => {}, 60000)\\"], { stdio: \\"ignore\\" }); require(\\"node:fs\\").writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 60000)", process.argv[1]], { cwd: process.argv[2], detached: true, stdio: "ignore" }); child.unref(); console.log(child.pid)' '${treePidFile}' '${session.root}'`,
      })
      const treeParentPid = Number(tree.stdout.trim())
      const treeChildPid = Number(await vi.waitFor(async () => await readFile(treePidFile, "utf8")))
      const unrelatedPid = await spawnOrphan(`${session.root}.other/keep`, `${session.root}.other`)

      try {
        await vi.waitFor(async () => {
          await expect(readFile(`/proc/${ownedPid}/status`, "utf8")).resolves.toContain("PPid:\t1")
          await expect(readFile(`/proc/${cwdOwnedPid}/status`, "utf8")).resolves.toContain("PPid:\t1")
          await expect(readFile(`/proc/${treeParentPid}/status`, "utf8")).resolves.toContain("PPid:\t1")
          await expect(readFile(`/proc/${envOwnedPid}/status`, "utf8")).resolves.toContain("PPid:\t1")
          await expect(readFile(`/proc/${fdOwnedPid}/status`, "utf8")).resolves.toContain("PPid:\t1")
          await expect(readFile(`/proc/${commandOwnedPid}/status`, "utf8")).resolves.toContain("PPid:\t1")
          await expect(readFile(`/proc/${unrelatedPid}/status`, "utf8")).resolves.toContain("PPid:\t1")
        })
        await session.destroy()
        await expect(stat(session.root)).rejects.toMatchObject({ code: "ENOENT" })
        await vi.waitFor(async () => {
          const status = await readFile(`/proc/${ownedPid}/status`, "utf8").catch(() => undefined)
          expect(status === undefined || /^State:\s+Z/m.test(status)).toBe(true)
          const cwdStatus = await readFile(`/proc/${cwdOwnedPid}/status`, "utf8").catch(() => undefined)
          expect(cwdStatus === undefined || /^State:\s+Z/m.test(cwdStatus)).toBe(true)
          const treeChildStatus = await readFile(`/proc/${treeChildPid}/status`, "utf8").catch(() => undefined)
          expect(treeChildStatus === undefined || /^State:\s+Z/m.test(treeChildStatus)).toBe(true)
          const envStatus = await readFile(`/proc/${envOwnedPid}/status`, "utf8").catch(() => undefined)
          expect(envStatus === undefined || /^State:\s+Z/m.test(envStatus)).toBe(true)
          const fdStatus = await readFile(`/proc/${fdOwnedPid}/status`, "utf8").catch(() => undefined)
          expect(fdStatus === undefined || /^State:\s+Z/m.test(fdStatus)).toBe(true)
          const commandStatus = await readFile(`/proc/${commandOwnedPid}/status`, "utf8").catch(() => undefined)
          expect(commandStatus === undefined || /^State:\s+Z/m.test(commandStatus)).toBe(true)
        })
        expect(() => process.kill(unrelatedPid, 0)).not.toThrow()
      }
      finally {
        try { process.kill(unrelatedPid, "SIGKILL") } catch {}
        try { process.kill(ownedPid, "SIGKILL") } catch {}
        try { process.kill(cwdOwnedPid, "SIGKILL") } catch {}
        try { process.kill(treeParentPid, "SIGKILL") } catch {}
        try { process.kill(treeChildPid, "SIGKILL") } catch {}
        try { process.kill(envOwnedPid, "SIGKILL") } catch {}
        try { process.kill(fdOwnedPid, "SIGKILL") } catch {}
        try { process.kill(commandOwnedPid, "SIGKILL") } catch {}
      }
    })
  }, 30_000)

  it("removes a partial disposable checkout when revision verification fails", async () => {
    const root = await temporaryRoot()
    const repository = join(root, "repository")
    const bin = join(root, "bin")
    const log = join(root, "crabbox.log")
    await Promise.all([mkdir(repository), mkdir(bin)])
    await fakeCrabbox(bin)
    await runGit(repository, ["init", "--initial-branch=main"])
    await writeFile(join(repository, "README.md"), "checkout\n")
    await runGit(repository, ["add", "README.md"])
    await runGit(repository, [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@example.com",
      "commit", "-m", "initial",
    ])

    await withEnvironment(
      { CRABBOX_TEST_LOG: log, PATH: `${bin}:${process.env.PATH || ""}` },
      async () => {
        const box = await resolveBox({
          checkout: {
            ref: "refs/heads/main",
            remote: repository,
            sha: "0".repeat(40),
          },
          runtime: createCrabboxRuntime({ profile: "babysitter" }),
        }, {})

        await expect(
          boxProvider(box).createSession(),
        ).rejects.toThrow("checkout revision mismatch")
        const cleanup = (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .findLast(invocation => (
            invocation.includes("rm -rf --") && invocation.includes("/tmp/vitehub-box.")
          ))
        expect(cleanup).toBeDefined()
        const sessionRoot = cleanup?.match(/\/tmp\/vitehub-box\.[A-Za-z0-9]+/)?.[0]
        expect(sessionRoot).toBeDefined()
        await expect(stat(sessionRoot!)).rejects.toMatchObject({ code: "ENOENT" })
      },
    )
  }, 30_000)

  it("rejects invalid Box requirement names", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    await mkdir(workspace)

    await expect(resolveBox({
      runtime: createCrabboxRuntime(),
      requires: [""],
      cwd: workspace,
    }, {})).rejects.toThrow("Box requirements must be non-empty commands");
    await expect(resolveBox({
      runtime: createCrabboxRuntime(),
      // SAFETY: this deliberately supplies an invalid runtime value to exercise validation.
      requires: [null as never],
      cwd: workspace,
    }, {})).rejects.toThrow("Box requirements must be commands or direct command checks");
    for (const timeout of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
      await expect(resolveBox({
        runtime: createCrabboxRuntime(),
        requires: [{ command: "gh", timeout }],
        cwd: workspace,
      }, {})).rejects.toThrow("Box requirement timeout must be a positive integer");
    }
  })

  it("materializes environment, files, and writable state before validation", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "remote-state");
    const bin = join(root, "bin");
    const log = join(root, "crabbox.log");
    await Promise.all([mkdir(workspace), mkdir(bin), mkdir(stateRoot, { mode: 0o755 })]);
    await chmod(stateRoot, 0o755);
    await fakeCrabbox(bin);
    await executable(
      bin,
      "acme",
      'test "$ACME_TOKEN" = ready && test -f "$HOME/.acme/config.toml" && test -f "$HOME/.acme/auth.json"',
    );

    await withEnvironment(
      { CRABBOX_TEST_LOG: log, PATH: `${bin}:${process.env.PATH || ""}` },
      async () => {
        const box = await resolveBox(
          {
            cwd: workspace,
            env: { ACME_TOKEN: "ready" },
            home: {
              files: { ".acme/config.toml": { contents: 'mode = "file"\n' } },
              state: {
                ".acme": {
                  key: "portable-box-test/acme",
                  seed: { "auth.json": { contents: "seed" } },
                },
              },
            },
            requires: [{ command: "acme", args: ["auth", "status"] }],
            runtime: createCrabboxRuntime({ profile: "babysitter", stateRoot }),
          },
          {},
        );
        const sandbox = boxProvider(box);
        const first = await sandbox.createSession();
        await expect(
          first.run({ command: 'printf "%s|" "$ACME_TOKEN"; cat "$HOME/.acme/auth.json"' }),
        ).resolves.toMatchObject({ stdout: "ready|seed" });
        await expect(first.run({ command: "true", env: { HOME: "/ambient" } })).rejects.toThrow(
          "cannot override HOME",
        );
        await expect(
          first.run({ command: "true", env: { CODEX_HOME: "/ambient" } }),
        ).rejects.toThrow("cannot override CODEX_HOME");
        await first.run({
          command:
            'printf refreshed > "$HOME/.acme/auth.next" && mv "$HOME/.acme/auth.next" "$HOME/.acme/auth.json"',
        });
        await first.run({ command: 'rm "$HOME/.acme/config.toml" && mkdir "$HOME/.acme/config.toml"' });
        await first.destroy?.();

        const second = await sandbox.createSession();
        await expect(
          second.run({ command: 'cat "$HOME/.acme/auth.json" "$HOME/.acme/config.toml"' }),
        ).resolves.toMatchObject({ stdout: 'refreshedmode = "file"\n' });
        await second.destroy?.();

        const withoutProjection = await resolveBox(
          {
            cwd: workspace,
            home: { state: { ".acme": { key: "portable-box-test/acme" } } },
            runtime: createCrabboxRuntime({ profile: "babysitter", stateRoot }),
          },
          {},
        );
        const third = await boxProvider(withoutProjection).createSession();
        await expect(
          third.run({ command: 'test ! -e "$HOME/.acme/config.toml" && cat "$HOME/.acme/auth.json"' }),
        ).resolves.toMatchObject({ stdout: "refreshed" });
        await third.destroy?.();
        expect((await stat(stateRoot)).mode & 0o777).toBe(0o755);

        const invocations = await readFile(log, "utf8");
        expect(invocations).not.toContain("ready");
        expect(invocations).not.toContain("c2VlZA==");
      },
    );
  }, 30_000);

  it("retries remote state seeding after a later boot failure", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "remote-state");
    const bin = join(root, "bin");
    let attempts = 0;
    await Promise.all([mkdir(workspace), mkdir(bin)]);
    await fakeCrabbox(bin);

    await withEnvironment({ PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({
          cwd: workspace,
          home: {
            state: {
              ".acme": {
                key: "portable-box-test/remote-seed-retry",
                seed: {
                  "auth.json": { contents: () => (++attempts === 1 ? "bad" : "seed") },
                },
              },
            },
          },
          runtime: createCrabboxRuntime({ profile: "babysitter", stateRoot }),
        },
        {},
      );
      const sandbox = boxProvider(box);

      await expect(
        sandbox.createSession({
          onFirstCreate: async () => {
            throw new Error("bad seed");
          },
        }),
      ).rejects.toThrow("bad seed");
      const session = await sandbox.createSession();
      await expect(session.run({ command: 'cat "$HOME/.acme/auth.json"' })).resolves.toMatchObject({
        stdout: "seed",
      });
      expect(attempts).toBe(2);
      await session.destroy?.();
    });
  }, 30_000);

  it("serializes writable state across different workspaces", async () => {
    const root = await temporaryRoot();
    const workspaces = [join(root, "pr-1"), join(root, "pr-2")];
    const stateRoot = join(root, "remote-state");
    const bin = join(root, "bin");
    await Promise.all([...workspaces.map((workspace) => mkdir(workspace)), mkdir(bin)]);
    await fakeCrabbox(bin);

    await withEnvironment({ PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const sandboxes = await Promise.all(
        workspaces.map(async (cwd) => {
          const box = await resolveBox(
            {
              cwd,
              home: { state: { ".acme": { key: "portable-box-test/shared-remote-state" } } },
              runtime: createCrabboxRuntime({ profile: "babysitter", stateRoot }),
            },
            {},
          );
          return boxProvider(box);
        }),
      );
      const first = await sandboxes[0].createSession();
      let opened = false;
      const second = sandboxes[1].createSession().then((session) => {
        opened = true;
        return session;
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(opened).toBe(false);
      await first.destroy?.();
      await (await second).destroy?.();
    });
  }, 30_000);

  it("preserves non-directory remote state targets", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "remote-state");
    const bin = join(root, "bin");
    await Promise.all([mkdir(workspace), mkdir(bin)]);
    await fakeCrabbox(bin);

    await withEnvironment({ PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox(
        {
          cwd: workspace,
          home: { state: { ".acme": { key: "portable-box-test/non-directory" } } },
          runtime: createCrabboxRuntime({ profile: "babysitter", stateRoot }),
        },
        {},
      );
      const sandbox = boxProvider(box);
      const first = await sandbox.createSession();
      await first.destroy?.();
      const entries = await readdir(stateRoot, { withFileTypes: true });
      const state = entries.find((entry) => entry.isDirectory() && entry.name !== ".locks");
      expect(state).toBeDefined();
      const persistent = join(stateRoot, state!.name);
      await rm(persistent, { recursive: true });
      await writeFile(persistent, "operator-owned");

      await expect(sandbox.createSession()).rejects.toThrow("inspect Box state");
      await expect(readFile(persistent, "utf8")).resolves.toBe("operator-owned");
    });
  }, 30_000);

  it("invalidates a session when its remote state lease is lost", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "remote-state");
    const holder = join(root, "state-holder.pid");
    const bin = join(root, "bin");
    await Promise.all([mkdir(workspace), mkdir(bin)]);
    await fakeCrabbox(bin);

    await withEnvironment(
      {
        CRABBOX_TEST_STATE_HOLDER: holder,
        PATH: `${bin}:${process.env.PATH || ""}`,
      },
      async () => {
        const box = await resolveBox(
          {
            cwd: workspace,
            home: { state: { ".acme": { key: "portable-box-test/lost-remote-state" } } },
            runtime: createCrabboxRuntime({ profile: "babysitter", stateRoot }),
          },
          {},
        );
        const session = await boxProvider(box).createSession();
        const holderPid = Number(await readFile(holder, "utf8"));
        process.kill(holderPid, "SIGKILL");

        let failure: unknown;
        for (let attempt = 0; attempt < 100 && !failure; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          try {
            await session.run({ command: "true" });
          } catch (error) {
            failure = error;
          }
        }
        expect(failure).toBeInstanceOf(Error);
        // SAFETY: the preceding assertion verifies the captured value is an Error.
        expect((failure as Error).message).toContain("Crabbox state lease was lost");
        await expect(session.destroy?.()).rejects.toThrow("Crabbox state lease was lost");
      },
    );
  }, 30_000);

  it("canonicalizes symlinked workspace roots", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const linkedWorkspace = join(root, "linked-workspace")
    await mkdir(workspace)
    await symlink(workspace, linkedWorkspace)

    const box = await resolveBox({ runtime: createCrabboxRuntime(), cwd: linkedWorkspace }, {})

    expect(box.plan.workspace.path).toBe(await realpath(workspace))
  })

  it("rejects archive entries beneath local symlinks", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const source = join(root, "source")
    const archive = join(root, "workspace.tar")
    await Promise.all([mkdir(workspace), mkdir(join(source, "linked"), { recursive: true })])
    await writeFile(join(source, "linked", "file.txt"), "remote")
    await execFileAsync("tar", ["-cf", archive, "-C", source, "linked/file.txt"])
    await symlink(root, join(workspace, "linked"))

    await expect(rejectSymlinkedArchiveParents(workspace, archive)).rejects.toThrow("conflicts with local symlink: linked")
  })

  it("rejects unsafe workspace archive paths", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const archive = join(root, "workspace.tar")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await writeFile(archive, "")
    await executable(bin, "tar", `test "$1" = -tf || exit 2\nprintf '%s\\n' '../outside.txt'`)

    await withEnvironment({ PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      await expect(rejectSymlinkedArchiveParents(workspace, archive)).rejects.toThrow("archive contains an invalid path")
    })
  })

  it("removes empty parents before extracting replacement entries", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const source = join(root, "source")
    const archive = join(root, "workspace.tar")
    await Promise.all([mkdir(join(workspace, "dir", "sub"), { recursive: true }), mkdir(source)])
    await writeFile(join(workspace, "dir", "sub", "file.txt"), "local")
    await writeFile(join(source, "dir"), "remote")
    await execFileAsync("tar", ["-cf", archive, "-C", source, "dir"])

    await pruneWorkspaceForArchive(workspace, archive, ["dir/sub/file.txt"])

    await expect(stat(join(workspace, "dir"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("removes deleted empty directories", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const source = join(root, "source")
    const archive = join(root, "workspace.tar")
    await Promise.all([mkdir(join(workspace, "empty"), { recursive: true }), mkdir(source)])
    await execFileAsync("tar", ["-cf", archive, "-C", source, "."])

    await pruneWorkspaceForArchive(workspace, archive, ["empty"])

    await expect(stat(join(workspace, "empty"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("replaces files with archived directories", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const source = join(root, "source")
    const archive = join(root, "workspace.tar")
    await Promise.all([mkdir(workspace), mkdir(join(source, "entry"), { recursive: true })])
    await Promise.all([writeFile(join(workspace, "entry"), "file"), writeFile(join(source, "entry", "nested.txt"), "nested")])
    await execFileAsync("tar", ["-cf", archive, "-C", source, "."])

    await pruneWorkspaceForArchive(workspace, archive, ["entry"])
    await execFileAsync("tar", ["-xf", archive, "-C", workspace])

    await expect(readFile(join(workspace, "entry", "nested.txt"), "utf8")).resolves.toBe("nested")
  })

  it("removes directories replaced by archived symlinks", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const source = join(root, "source")
    const archive = join(root, "workspace.tar")
    await Promise.all([mkdir(join(workspace, "entry"), { recursive: true }), mkdir(source)])
    await writeFile(join(workspace, "entry", "file.txt"), "local")
    await symlink("target", join(source, "entry"))
    await execFileAsync("tar", ["-cf", archive, "-C", source, "entry"])

    await pruneWorkspaceForArchive(workspace, archive, ["entry", "entry/file.txt"])

    await expect(stat(join(workspace, "entry"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("rejects deleted paths beneath local symlinks", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const source = join(root, "source")
    const archive = join(root, "workspace.tar")
    await Promise.all([mkdir(workspace), mkdir(source)])
    await symlink(root, join(workspace, "linked"))
    await writeFile(join(root, "outside.txt"), "keep")
    await execFileAsync("tar", ["-cf", archive, "-C", source, "."])

    await expect(pruneWorkspaceForArchive(workspace, archive, ["linked/outside.txt"])).rejects.toThrow("conflicts with local symlink: linked")
    await expect(readFile(join(root, "outside.txt"), "utf8")).resolves.toBe("keep")
  })

  it("boots through Crabbox, validates requirements there, and preserves workspace mutations", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const log = join(root, "crabbox.log")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await Promise.all([
      writeFile(join(workspace, ".env"), "local"),
      writeFile(join(workspace, ".gitignore"), ".env\n"),
      writeFile(join(workspace, "deleted.txt"), "delete me"),
      writeFile(join(workspace, "newly-ignored.txt"), "keep me"),
    ])
    await runGit(workspace, ["init"])
    await runGit(workspace, ["add", ".gitignore", "deleted.txt"])
    await fakeCrabbox(bin)
    await Promise.all([
      executable(bin, "codex", "exit 0"),
      executable(bin, "gh", "exit 0"),
      executable(bin, "pnpm", "exit 0"),
    ])

    await withEnvironment({ CRABBOX_TEST_LOG: log, PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({
        runtime: createCrabboxRuntime({ network: "direct", profile: "babysitter", reclaim: true }),
        requires: ["codex", { command: "gh", args: ["auth", "status"] }, "pnpm"],
        cwd: workspace,
      }, {},
        );
        const sandbox = boxProvider(box)
      const session = await sandbox.createSession()
      const cacheRoot = dirname(session.defaultWorkingDirectory)

      await session.writeTextFile({ content: "cache", path: "cache.txt" })
      await session.writeTextFile({ content: "CACHE", path: "cache.txt" })
      await expect(session.readTextFile({ path: "cache.txt" })).resolves.toBe("CACHE")
      await session.writeTextFile({ content: "cache", path: "cache.txt" })
      await expect(session.readTextFile({ path: "cache.txt" })).resolves.toBe("cache")
      await session.run({ command: `ln -s cache.txt ${cacheRoot}/linked-cache.txt` })
      await expect(session.readTextFile({ path: "linked-cache.txt" })).resolves.toBe("cache")
      await session.writeTextFile({ content: "updated", path: "linked-cache.txt" })
      await expect(session.run({ command: `test -L ${cacheRoot}/linked-cache.txt && cat ${cacheRoot}/cache.txt` })).resolves.toMatchObject({ exitCode: 0, stdout: "updated" })
      await session.run({ command: `ln -s missing-cache.txt ${cacheRoot}/dangling-cache.txt` })
      await session.writeTextFile({ content: "created", path: "dangling-cache.txt" })
      await expect(session.run({ command: `test -L ${cacheRoot}/dangling-cache.txt && cat ${cacheRoot}/missing-cache.txt` })).resolves.toMatchObject({ exitCode: 0, stdout: "created" })
      await session.run({ command: `mkdir ${cacheRoot}/directory.txt` })
      await expect(session.writeTextFile({ content: "not a directory", path: "directory.txt" })).rejects.toThrow("prepare directory.txt")
      await expect(session.writeTextFile({ content: "not a directory", path: "missing-directory/" })).rejects.toThrow("write missing-directory/")
      await expect(readdir(join(cacheRoot, "directory.txt"))).resolves.toEqual([])
      await expect(session.run({
        command: "printf changed > changed.txt && printf 'newly-ignored.txt\\n' >> .gitignore && rm deleted.txt",
        workingDirectory: join(cacheRoot, "workspace"),
      })).resolves.toMatchObject({ exitCode: 0 })
      await expect(readFile(join(workspace, "changed.txt"), "utf8")).resolves.toBe("changed")
      await expect(session.getPortUrl({ port: 3000, protocol: "ws" })).resolves.toBe("ws://127.0.0.1:3000")

      await session.destroy()
      await expect(readFile(join(cacheRoot, "cache.txt"))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(join(workspace, ".env"), "utf8")).resolves.toBe("local")
      await expect(readFile(join(workspace, "newly-ignored.txt"), "utf8")).resolves.toBe("keep me")
      await expect(stat(join(workspace, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readdir(workspace)).resolves.toEqual([".env", ".git", ".gitignore", "changed.txt", "newly-ignored.txt"])

      const workspaceCwd = await realpath(workspace)
      const invocations = (await readFile(log, "utf8")).trim().split("\n")
      const copies = invocations.filter(invocation => invocation.includes("|cp|"))
      expect(copies).toHaveLength(10)
      expect(copies.every(copy => copy.includes("--provider ssh --target linux --id static_test"))).toBe(true)
      expect(copies.filter(copy => copy.includes(`SANDBOX:${cacheRoot}/.vitehub-write-`))).toHaveLength(7)
      expect(invocations).not.toContain(expect.stringContaining("|tunnel|"))
      expect(invocations.every(invocation => invocation.startsWith(`${workspaceCwd}|`))).toBe(true)
      expect(invocations.every(invocation => !invocation.includes("--static-work-root"))).toBe(true)
      expect(invocations.find(invocation => invocation.includes("|warmup|"))).toContain("--reclaim")
    })
  }, 30_000)

  it("tunnels Static SSH ports by default and reuses the forward", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const log = join(root, "crabbox.log")
    const tunnelPid = join(root, "tunnel.pid")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({
      CRABBOX_TEST_LOG: log,
      CRABBOX_TEST_TUNNEL_PID: tunnelPid,
      PATH: `${bin}:${process.env.PATH || ""}`,
    }, async () => {
      const box = await resolveBox({ runtime: createCrabboxRuntime({ profile: "babysitter" }), cwd: workspace }, {})
      const sandbox = boxProvider(box)
      const session = await sandbox.createSession()

      const httpUrl = await session.getPortUrl({ port: 3000 })
      const wsUrl = await session.getPortUrl({ port: 3000, protocol: "ws" })
      expect(httpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(wsUrl).toBe(httpUrl.replace("http:", "ws:"))
      const pid = Number(await readFile(tunnelPid, "utf8"))
      await session.destroy()

      expect(() => process.kill(pid, 0)).toThrow()
      const tunnels = (await readFile(log, "utf8")).split("\n").filter(line => line.includes("|tunnel|"))
      expect(tunnels).toEqual([
        expect.stringContaining("|tunnel|--provider ssh --target linux --id static_test 3000"),
      ])
    })
  }, 30_000)

  it("claims each sibling workspace consistently", async () => {
    const root = await temporaryRoot()
    const workspaces = [join(root, "pr-1"), join(root, "pr-2")]
    const bin = join(root, "bin")
    const claim = join(root, "claim")
    const log = join(root, "crabbox.log")
    await Promise.all([...workspaces.map(workspace => mkdir(workspace)), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({
      CRABBOX_TEST_CLAIM: claim,
      CRABBOX_TEST_LOG: log,
      PATH: `${bin}:${process.env.PATH || ""}`,
    }, async () => {
      const sessions = await Promise.all(workspaces.map(async (workspace) => {
        const box = await resolveBox({
          runtime: createCrabboxRuntime({ profile: "babysitter", reclaim: true }),
          cwd: workspace,
        }, {})
        return await boxProvider(box).createSession()
      }))

      await Promise.all(sessions.map(session => session.destroy()))

      const invocations = (await readFile(log, "utf8")).trim().split("\n")
      const warmups = invocations.filter(invocation => invocation.includes("|warmup|"))
      expect(warmups).toHaveLength(2)
      expect(warmups.map(invocation => invocation.split("|", 1)[0]).sort()).toEqual((await Promise.all(workspaces.map(workspace => realpath(workspace)))).sort())
      expect(invocations.every(invocation => !invocation.includes("--static-work-root"))).toBe(true)
      expect(warmups.every(invocation => invocation.endsWith("--reclaim --timing-json"))).toBe(true)
    })
  }, 30_000)

  it("isolates concurrent sessions on a profile-configured Crabbox static host", async () => {
    const root = await temporaryRoot()
    const workspaces = [join(root, "pr-1"), join(root, "pr-2")]
    const bin = join(root, "bin")
    const staticIdLog = join(root, "static-ids.log")
    await Promise.all([...workspaces.map(workspace => mkdir(workspace)), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({
      CRABBOX_TEST_STATIC_ID_LOG: staticIdLog,
      PATH: `${bin}:${process.env.PATH || ""}`,
    }, async () => {
      const sessions = await Promise.all(workspaces.map(async (workspace) => {
        const box = await resolveBox({
          runtime: createCrabboxRuntime({ profile: "babysitter", reclaim: true }),
          cwd: workspace,
        }, {})
        return await boxProvider(box).createSession()
      }))

      await Promise.all(sessions.map(session => session.destroy()))
    })

    const ids = [...new Set((await readFile(staticIdLog, "utf8")).trim().split("\n"))]
    expect(ids).toHaveLength(2)
    expect(ids.every(id => /^vitehub-[0-9a-f-]{36}$/.test(id))).toBe(true)
  }, 30_000)

  it("serializes sessions that share an authoritative workspace", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({ PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({ runtime: createCrabboxRuntime({ profile: "babysitter" }), cwd: workspace }, {})
      const sandbox = boxProvider(box)
      const first = await sandbox.createSession()
      let created = false
      const second = sandbox.createSession().then((session) => {
        created = true
        return session
      })

      await new Promise(resolve => setTimeout(resolve, 20))
      expect(created).toBe(false)
      await first.destroy()
      await (await second).destroy()
    })
  }, 30_000)

  it("aborts while waiting for an authoritative workspace", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({ PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({ runtime: createCrabboxRuntime({ profile: "babysitter" }), cwd: workspace }, {})
      const sandbox = boxProvider(box)
      const first = await sandbox.createSession()
      const controller = new AbortController()
      const second = sandbox.createSession({ abortSignal: controller.signal })
      controller.abort(new Error("cancelled"))

      await expect(second).rejects.toThrow("cancelled")
      await first.destroy?.()
      await (await sandbox.createSession()).destroy?.()
    })
  }, 30_000)

  it("removes the disposable cache when workspace sync fails", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const log = join(root, "crabbox.log")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)

    await withEnvironment({ CRABBOX_TEST_LOG: log, PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({ runtime: createCrabboxRuntime({ profile: "babysitter" }), cwd: workspace }, {})
      const session = await boxProvider(box).createSession()

      await expect(
        withEnvironment({ CRABBOX_TEST_FAIL_SYNC: "1" }, async () => await session.destroy?.()),
      ).rejects.toThrow()
      const cleanup = (await readFile(log, "utf8")).trim().split("\n").at(-1)
      expect(cleanup).toContain("rm -rf --")
      expect(cleanup).toContain("/tmp/vitehub-box.")
    })
  }, 30_000)

  it("isolates Crabbox state across concurrent session bootstrap", async () => {
    const root = await temporaryRoot()
    const workspaces = [join(root, "pr-1"), join(root, "pr-2")]
    const bin = join(root, "bin")
    const inheritedState = join(root, "inherited-state")
    const race = join(root, "copy-race")
    const stateLog = join(root, "state.log")
    await Promise.all([...workspaces.map(workspace => mkdir(workspace)), mkdir(bin), mkdir(inheritedState)])
    await fakeCrabbox(bin)

    await withEnvironment({
      CRABBOX_TEST_STATE_LOG: stateLog,
      CRABBOX_TEST_STATE_RACE: race,
      PATH: `${bin}:${process.env.PATH || ""}`,
      XDG_STATE_HOME: inheritedState,
    }, async () => {
      const sessions = await Promise.all(workspaces.map(async (workspace, index) => {
        const box = await resolveBox({
          runtime: createCrabboxRuntime({ profile: "babysitter", reclaim: true }),
          cwd: workspace,
        }, {})
        return await boxProvider(box).createSession({
          async onFirstCreate(session) {
            await session.writeTextFile({ content: `bootstrap-${index}`, path: "bootstrap.txt" })
          },
        })
      }))

      const stateHomes = [...new Set((await readFile(stateLog, "utf8")).trim().split("\n"))]
      expect(stateHomes).toHaveLength(2)
      expect(stateHomes).not.toContain(inheritedState)
      await expect(Promise.all(stateHomes.map(stateHome => stat(stateHome)))).resolves.toHaveLength(2)

      await Promise.all(sessions.map(session => session.destroy?.()))
      for (const stateHome of stateHomes) {
        await expect(stat(stateHome)).rejects.toMatchObject({ code: "ENOENT" })
      }
    })
  }, 30_000)

  it("stops boot when a direct requirement check fails", async () => {
    const root = await temporaryRoot()
    const workspace = join(root, "workspace")
    const bin = join(root, "bin")
    const stateLog = join(root, "state.log")
    await Promise.all([mkdir(workspace), mkdir(bin)])
    await fakeCrabbox(bin)
    await executable(bin, "gh", 'echo "token=$GH_TOKEN not logged in" >&2\nexit 1')

    await withEnvironment({ CRABBOX_TEST_STATE_LOG: stateLog, PATH: `${bin}:${process.env.PATH || ""}` }, async () => {
      const box = await resolveBox({
        env: { GH_TOKEN: "crabbox-secret" },
        runtime: createCrabboxRuntime({ profile: "babysitter" }),
        requires: [{ name: "GitHub CLI", command: "gh", args: ["auth", "status"] }],
            cwd: workspace,
      }, {})
      const sandbox = boxProvider(box)
      // SAFETY: this test configures a failing requirement, so session creation rejects with Error.
      const failure = await sandbox.createSession().catch((error: unknown) => error as Error) as Error
      expect(failure.message).toContain('Box requirement "GitHub CLI" failed: exit code 1')
      expect(failure.message).toContain("token=[redacted] not logged in")
      expect(failure.message).not.toContain("crabbox-secret")
        const [stateHome] = [...new Set((await readFile(stateLog, "utf8")).trim().split("\n"))]
      await expect(stat(stateHome)).rejects.toMatchObject({ code: "ENOENT" })
    })
  }, 30_000)

})

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-box-test-"))
  roots.push(root)
  return root
}

async function fakeCrabbox(bin: string) {
  const command = join(bin, "crabbox")
  await writeFile(command,
    `#!/bin/sh
verb="$1"
shift
if [ -n "$CRABBOX_TEST_LOG" ]; then printf '%s|%s|%s\n' "$PWD" "$verb" "$*" >> "$CRABBOX_TEST_LOG"; fi
if [ -n "$CRABBOX_TEST_STATE_LOG" ]; then printf '%s\n' "$XDG_STATE_HOME" >> "$CRABBOX_TEST_STATE_LOG"; fi
if [ -n "$CRABBOX_TEST_STATIC_ID_LOG" ]; then printf '%s\n' "$CRABBOX_STATIC_ID" >> "$CRABBOX_TEST_STATIC_ID_LOG"; fi
case "$verb" in
  warmup)
    test "$CRABBOX_PROFILE" = babysitter || exit 20
    if [ -n "$CRABBOX_TEST_CLAIM" ]; then
      work_root=
      previous=
      for value in "$@"; do
        if [ "$previous" = --static-work-root ]; then work_root="$value"; break; fi
        previous="$value"
      done
      while ! mkdir "$CRABBOX_TEST_CLAIM.lock" 2>/dev/null; do sleep 0.01; done
      trap 'rmdir "$CRABBOX_TEST_CLAIM.lock"' EXIT
      if [ -f "$CRABBOX_TEST_CLAIM" ] && [ "$(cat "$CRABBOX_TEST_CLAIM")" != "$work_root" ]; then
        printf '%s\n' 'lease claim changed; retry' >&2
        exit 22
      fi
      printf '%s\n' "$work_root" > "$CRABBOX_TEST_CLAIM"
    fi
    printf '%s\n' '{"provider":"ssh","leaseId":"static_test","exitCode":0}' >&2
    ;;
  run)
    script=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --shell ]; then shift; script="$1"; break; fi
      if [ "$1" = --script-stdin ]; then
        test -z "$CRABBOX_TEST_FAIL_SYNC" || exit 24
        exec /bin/sh
      fi
      shift
    done
    if [ -n "$CRABBOX_TEST_STATE_HOLDER" ]; then
      case "$script" in
        *VITEHUB_STATE_READY_*)
          printf '%s\n' "$$" > "$CRABBOX_TEST_STATE_HOLDER"
          exec /bin/sh -c "$script"
          ;;
      esac
    fi
    /bin/sh -c "$script"
    ;;
  cp)
    if [ -n "$CRABBOX_TEST_STATE_RACE" ]; then
      mkdir -p "$CRABBOX_TEST_STATE_RACE" "$XDG_STATE_HOME"
      touch "$CRABBOX_TEST_STATE_RACE/$$"
      attempts=0
      while [ "$(find "$CRABBOX_TEST_STATE_RACE" -type f | wc -l | tr -d ' ')" -lt 2 ]; do
        attempts=$((attempts + 1))
        test "$attempts" -lt 500 || exit 22
        sleep 0.01
      done
      if ! mkdir "$XDG_STATE_HOME/copy.lock" 2>/dev/null; then
        printf '%s\n' 'lease claim changed; retry' >&2
        exit 23
      fi
      trap 'rmdir "$XDG_STATE_HOME/copy.lock"' EXIT
      sleep 0.05
    fi
    source=
    destination=
    for value in "$@"; do source="$destination"; destination="$value"; done
    source="\${source#SANDBOX:}"
    destination="\${destination#SANDBOX:}"
    /bin/cp "$source" "$destination"
    ;;
  tunnel)
    exec node -e 'const fs=require("node:fs");const net=require("node:net");if(process.env.CRABBOX_TEST_TUNNEL_PID)fs.writeFileSync(process.env.CRABBOX_TEST_TUNNEL_PID,String(process.pid));const server=net.createServer();server.listen(0,"127.0.0.1",()=>console.log("http://127.0.0.1:"+server.address().port))'
    ;;
  *) exit 21 ;;
esac
`,
  );
  await chmod(command, 0o755)
}

async function executable(bin: string, name: string, body: string) {
  const path = join(bin, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd })
}

async function withEnvironment<T>(environment: Record<string, string>, run: () => Promise<T>) {
  const original = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  Object.assign(process.env, environment)
  try {
    return await run()
  }
  finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
