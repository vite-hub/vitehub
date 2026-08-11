import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveBox } from "../src/index.ts";
import { createTrustedHostRuntime } from "../src/internal/trusted-host.ts";
import { boxProvider, type TestSession } from "./helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("createTrustedHostRuntime", () => {
  it("keeps the default workspace separate from runtime-owned paths", async () => {
    const box = await resolveBox({ runtime: createTrustedHostRuntime() }, {});
    const session = (await boxProvider(box).createSession()) as
      TestSession & { root: string };

    try {
      expect(session.defaultWorkingDirectory).toBe(join(session.root, "workspace"));
      await expect(stat(session.defaultWorkingDirectory)).resolves.toMatchObject({});
      expect(session.defaultWorkingDirectory).not.toBe(session.root);
      await expect(session.run({ command: "pwd" })).resolves.toMatchObject({
        stdout: `${session.defaultWorkingDirectory}\n`,
      });
    } finally {
      await session.destroy?.();
    }
  });

  it("reports dangling symlinks as existing files", async () => {
    const box = await resolveBox({ runtime: createTrustedHostRuntime() }, {});
    const session = await box.open();

    try {
      await symlink("missing.txt", join(session.cwd, "dangling.txt"));

      await expect(session.files.exists("workspace/dangling.txt")).resolves.toBe(true);
      await expect(session.files.list("workspace")).resolves.toContainEqual({
        path: "workspace/dangling.txt",
        type: "symlink",
      });
    } finally {
      await session.close();
    }
  });

  it("materializes a relative workspace from the process directory", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "marker.txt"), "workspace");

    const box = await resolveBox(
      { cwd: relative(process.cwd(), workspace), runtime: createTrustedHostRuntime() },
      {},
    );
    const session = await boxProvider(box).createSession();

    await expect(session.readTextFile({ path: "workspace/marker.txt" })).resolves.toBe("workspace");
    await session.destroy?.();
  });

  it("anchors deferred Home files to the resolved workspace", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "credential"), "anchored");
    const originalCwd = process.cwd();
    const box = await (async () => {
      try {
        process.chdir(root);
        return await resolveBox(
          {
            cwd: "workspace",
            home: { files: { ".acme/credential": { from: "credential" } } },
            runtime: createTrustedHostRuntime(),
          },
          {},
        );
      } finally {
        process.chdir(originalCwd);
      }
    })();

    const session = (await boxProvider(box).createSession()) as typeof sessionWithEnv;
    await expect(readFile(join(session.env.HOME, ".acme", "credential"), "utf8")).resolves.toBe(
      "anchored",
    );
    await session.destroy?.();
  });

  it("materializes one private environment for every Box command", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "state");
    const ambientHome = join(root, "ambient");
    const bin = join(root, "bin");
    await Promise.all([
      mkdir(join(workspace, ".vitehub", "box"), { recursive: true }),
      mkdir(join(ambientHome, ".codex"), { recursive: true }),
      mkdir(bin),
    ]);
    await Promise.all([
      writeFile(join(workspace, ".vitehub", "box", "gitconfig"), "[credential]\n\thelper = test\n"),
      writeFile(join(ambientHome, ".codex", "auth.json"), "ambient"),
      executable(bin, "gh", 'test "$GH_TOKEN" = declared && test -f "$HOME/.gitconfig"'),
    ]);

    const box = await withEnvironment(
      {
        AMBIENT_TOKEN: "must-not-leak",
        HOME: ambientHome,
        PATH: bin,
      },
      () =>
        resolveBox(
          {
            cwd: workspace,
            env: {
              GH_TOKEN: "declared",
            },
            home: {
              files: {
                ".gitconfig": { from: ".vitehub/box/gitconfig" },
                ".codex/config.toml": { contents: 'cli_auth_credentials_store = "file"\n' },
              },
              state: {
                ".codex": {
                  key: "portable-box-test/codex",
                  seed: {
                    "auth.json": { contents: "seed" },
                  },
                },
              },
            },
            requires: [{ command: "gh", args: ["auth", "status"] }],
            runtime: createTrustedHostRuntime({ stateRoot }),
          },
          {},
        ),
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
      home: { state: [".codex"] },
      requirements: [{ command: "gh", name: "gh auth status" }],
      runtime: "trusted-host",
      workspace: { path: workspace, state: "authoritative" },
    });
    expect(box.open).toBeTypeOf("function");
    expect(JSON.stringify(box)).not.toContain("declared");
    expect(JSON.stringify(box)).not.toContain("sandbox");

    const session = (await withEnvironment(
      { PATH: bin },
      async () => await boxProvider(box).createSession(),
    )) as typeof sessionWithEnv;
    const home = session.env.HOME;
    expect(home).not.toBe(ambientHome);
    expect(session.env).toMatchObject({
      GH_TOKEN: "declared",
      HOME: home,
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local", "state"),
    });
    expect(session.env.AMBIENT_TOKEN).toBeUndefined();
    await expect(readFile(join(home, ".gitconfig"), "utf8")).resolves.toContain("helper = test");
    await expect(readFile(join(home, ".codex", "auth.json"), "utf8")).resolves.toBe("seed");
    await expect(readFile(join(home, ".codex", "config.toml"), "utf8")).resolves.toContain("file");
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, ".gitconfig"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".codex", "auth.json"))).mode & 0o777).toBe(0o600);
    await expect(session.run({ command: "true", env: { HOME: ambientHome } })).rejects.toThrow(
      "cannot override HOME",
    );
    await expect(session.run({ command: "true", env: { CODEX_HOME: ambientHome } })).rejects.toThrow(
      "cannot override CODEX_HOME",
    );
    await session.destroy?.();
  });

  it("persists writable state and never reapplies a stale seed", async () => {
    const root = await temporaryRoot();
    const stateRoot = join(root, "state");
    let seeds = 0;
    const box = await resolveBox(
      {
        home: {
          state: {
            ".codex": {
              key: "portable-box-test/persistence",
              seed: {
                "auth.json": { contents: () => `${++seeds}` },
              },
            },
          },
        },
        runtime: createTrustedHostRuntime({ stateRoot }),
      },
      {},
    );
    const sandbox = boxProvider(box);

    const first = await sandbox.createSession();
    await first.run({
      command:
        'printf refreshed > "$HOME/.codex/auth.next" && mv "$HOME/.codex/auth.next" "$HOME/.codex/auth.json"',
    });
    await first.destroy?.();

    const second = (await sandbox.createSession()) as typeof sessionWithEnv;
    await expect(readFile(join(second.env.HOME, ".codex", "auth.json"), "utf8")).resolves.toBe(
      "refreshed",
    );
    expect(seeds).toBe(1);
    await second.destroy?.();
  });

  it("removes static projections that leave writable state", async () => {
    const root = await temporaryRoot();
    const stateRoot = join(root, "state");
    const definition = (project: boolean) => ({
      home: {
        ...(project ? { files: { ".codex/config.toml": { contents: "projected" } } } : {}),
        state: { ".codex": { key: "portable-box-test/projections" } },
      },
      runtime: createTrustedHostRuntime({ stateRoot }),
    });

    const firstBox = await resolveBox(definition(true), {});
    const first = (await boxProvider(firstBox).createSession()) as typeof sessionWithEnv;
    await expect(readFile(join(first.env.HOME, ".codex", "config.toml"), "utf8")).resolves.toBe("projected");
    await first.destroy?.();

    const secondBox = await resolveBox(definition(false), {});
    const second = (await boxProvider(secondBox).createSession()) as typeof sessionWithEnv;
    await expect(stat(join(second.env.HOME, ".codex", "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    await second.destroy?.();
  });

  it("replaces writable state directories with projected files", async () => {
    const root = await temporaryRoot();
    const stateRoot = join(root, "state");
    const withoutProjection = await resolveBox({
      home: { state: { ".codex": { key: "portable-box-test/directory-projection" } } },
      runtime: createTrustedHostRuntime({ stateRoot }),
    }, {});
    const first = (await boxProvider(withoutProjection).createSession()) as typeof sessionWithEnv;
    await mkdir(join(first.env.HOME, ".codex", "config.toml"));
    await first.destroy?.();

    const withProjection = await resolveBox({
      home: {
        files: { ".codex/config.toml": { contents: "projected" } },
        state: { ".codex": { key: "portable-box-test/directory-projection" } },
      },
      runtime: createTrustedHostRuntime({ stateRoot }),
    }, {});
    const second = (await boxProvider(withProjection).createSession()) as typeof sessionWithEnv;
    await expect(readFile(join(second.env.HOME, ".codex", "config.toml"), "utf8")).resolves.toBe("projected");
    await second.destroy?.();
  });

  it("rejects projected files beneath symlinked writable state parents", async () => {
    const root = await temporaryRoot();
    const stateRoot = join(root, "state");
    const outside = join(root, "outside");
    const key = "portable-box-test/projected-symlink";
    const persistent = join(stateRoot, createHash("sha256").update(key).digest("hex"));
    await Promise.all([mkdir(persistent, { recursive: true }), mkdir(outside)]);
    await symlink(outside, join(persistent, "skills"));
    const box = await resolveBox(
      {
        home: {
          files: { ".codex/skills/review/SKILL.md": { contents: "projected" } },
          state: { ".codex": { key } },
        },
        runtime: createTrustedHostRuntime({ stateRoot }),
      },
      {},
    );

    await expect(boxProvider(box).createSession()).rejects.toThrow(
      "projected path escapes writable state",
    );
    await expect(stat(join(outside, "review", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes sessions sharing writable state", async () => {
    const root = await temporaryRoot();
    const box = await resolveBox(
      {
        home: { state: { ".codex": { key: "portable-box-test/lease" } } },
        runtime: createTrustedHostRuntime({ stateRoot: join(root, "state") }),
      },
      {},
    );
    const sandbox = boxProvider(box);
    const first = await sandbox.createSession();
    let opened = false;
    const second = sandbox.createSession().then((session) => {
      opened = true;
      return session;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toBe(false);
    await first.destroy?.();
    await (await second).destroy?.();
  });

  it("stops background state writers before releasing the lease", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const box = await resolveBox(
      {
        home: {
          state: {
            ".acme": {
              key: "portable-box-test/background-writer",
              seed: { "auth.json": { contents: "stable" } },
            },
          },
        },
        runtime: createTrustedHostRuntime({ stateRoot: join(root, "state") }),
      },
      {},
    );
    const sandbox = boxProvider(box);
    const first = await sandbox.createSession();
    await first.run({
      command: '(sleep 0.2; printf late > "$HOME/.acme/auth.json") >/dev/null 2>&1 &',
    });
    await first.destroy?.();
    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = (await sandbox.createSession()) as typeof sessionWithEnv;
    await expect(readFile(join(second.env.HOME, ".acme", "auth.json"), "utf8")).resolves.toBe(
      "stable",
    );
    await second.destroy?.();
  });

  it("drops completed command process groups before teardown", async () => {
    if (process.platform === "win32") return;
    const box = await resolveBox({ runtime: createTrustedHostRuntime() }, {});
    const session = await boxProvider(box).createSession();
    await session.run({ command: "true" });

    const kill = vi.spyOn(process, "kill");
    try {
      await session.destroy?.();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("closes completed command sessions idempotently", async () => {
    const box = await resolveBox({ runtime: createTrustedHostRuntime() }, {});
    const session = await boxProvider(box).createSession();

    await session.run({ command: "true" });
    await session.destroy?.();
    await session.destroy?.();
  });

  it("does not start commands with an already-aborted signal", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "started");
    const box = await resolveBox({ runtime: createTrustedHostRuntime() }, {});
    const session = await boxProvider(box).createSession();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      session.run({ abortSignal: controller.signal, command: `touch '${marker}'` }),
    ).rejects.toThrow("cancelled");
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await session.destroy?.();
  });

  it("force-kills commands that ignore abort termination", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    const marker = join(root, "ready");
    const box = await resolveBox({ runtime: createTrustedHostRuntime() }, {});
    const session = await boxProvider(box).createSession();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const child = await session.spawn({
      abortSignal: controller.signal,
      command: `node -e "require('node:fs').writeFileSync(process.env.READY_MARKER, ''); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`,
      env: { READY_MARKER: marker },
    });

    try {
      await vi.waitFor(() => expect(stat(marker)).resolves.toMatchObject({}));
      const settled = child.wait().then(
        () => undefined,
        (error: unknown) => error,
      );
      controller.abort(reason);

      await expect(Promise.race([
        settled,
        new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500, "still-running")),
      ])).resolves.toBe(reason);
      await vi.waitFor(() => expect(() => process.kill(-child.pid!, 0)).toThrow());
    } finally {
      await session.destroy?.();
    }
  });

  it("retries seed materialization after a later boot failure", async () => {
    const root = await temporaryRoot();
    let attempts = 0;
    const box = await resolveBox(
      {
        home: {
          state: {
            ".acme": {
              key: "portable-box-test/seed-retry",
              seed: {
                "auth.json": { contents: () => (++attempts === 1 ? "bad" : "seed") },
              },
            },
          },
        },
        runtime: createTrustedHostRuntime({ stateRoot: join(root, "state") }),
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
    const session = (await sandbox.createSession()) as typeof sessionWithEnv;
    await expect(readFile(join(session.env.HOME, ".acme", "auth.json"), "utf8")).resolves.toBe(
      "seed",
    );
    expect(attempts).toBe(2);
    await session.destroy?.();
  });

  it("invalidates resumable identity for resolved inputs without exposing secrets", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await writeFile(join(outside, "credential"), "outside");
    await symlink(join(outside, "credential"), join(workspace, "credential"));

    const definition = (token: string, key = "portable-box-test/identity") =>
      ({
        cwd: workspace,
        env: { ACME_TOKEN: token },
        home: {
          files: { ".acme/credential": { from: "credential" } },
          state: { ".state": { key } },
        },
        runtime: createTrustedHostRuntime({ stateRoot: join(root, "state") }),
      }) as const;
    const first = await resolveBox(definition("secret-one"), {});
    const rotated = await resolveBox(definition("secret-two"), {});
    const differentState = await resolveBox(
      definition("secret-two", "portable-box-test/other"),
      {},
    );

    expect(rotated.plan.identity).not.toBe(first.plan.identity);
    expect(differentState.plan.identity).not.toBe(first.plan.identity);
    expect(JSON.stringify(first)).not.toContain("secret-one");
    await expect(boxProvider(first).createSession()).rejects.toThrow(
      "Box project file is unavailable: credential",
    );
  });

  it("fails closed when a declared input is missing", async () => {
    const root = await temporaryRoot();
    const ambientHome = join(root, "ambient");
    await mkdir(ambientHome);
    const box = await withEnvironment({ GH_TOKEN: "ambient", HOME: ambientHome }, () =>
      resolveBox(
        {
          env: { GH_TOKEN: () => undefined },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    );

    await expect(boxProvider(box).createSession()).rejects.toThrow(
      "Box environment value GH_TOKEN is required",
    );
  });

  it("validates generic requirements after materialization", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    await mkdir(bin);
    await executable(bin, "acme", 'test "$HOME" != "$AMBIENT_HOME" && test "$ACME_TOKEN" = ready');

    const box = await withEnvironment({ PATH: bin }, () =>
      resolveBox(
        {
          env: { ACME_TOKEN: "ready", AMBIENT_HOME: process.env.HOME || "" },
          requires: ["acme"],
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    );

    const session = await withEnvironment(
      { PATH: bin },
      async () => await boxProvider(box).createSession(),
    );
    await session.destroy?.();
  });

  it("validates requirements with the Windows Path environment key", async () => {
    const root = await temporaryRoot();
    const bin = join(root, "bin");
    await mkdir(bin);
    await executable(bin, "acme", "exit 0");

    const box = await withEnvironment({ PATH: "", Path: bin }, () =>
      resolveBox({ requires: ["acme"], runtime: createTrustedHostRuntime() }, {}),
    );
    const session = await withEnvironment(
      { PATH: "", Path: bin },
      async () => await boxProvider(box).createSession(),
    );
    await session.destroy?.();
  });

  it("does not validate requirements from the ambient process directory", async () => {
    const box = await resolveBox(
      {
        requires: [{ command: "sh", args: ["-c", "test -f package.json"] }],
        runtime: createTrustedHostRuntime(),
      },
      {},
    );

    await expect(boxProvider(box).createSession()).rejects.toThrow(
      'Box requirement "sh -c test -f package.json" failed',
    );
  });

  it("reports trusted-host requirement errors without exposing Box environment values", async () => {
    const box = await resolveBox(
      {
        env: { ACCESS_TOKEN: "trusted-host-secret" },
        requires: [{
          command: "sh",
          args: [
            "-c",
            'printf "credential %s was rejected\\n" "$ACCESS_TOKEN" >&2; exit 3',
            "trusted-host-secret",
          ],
        }],
        runtime: createTrustedHostRuntime(),
      },
      {},
    );

    const failure = await boxProvider(box).createSession()
      .catch((error: unknown) => error as Error) as Error;
    expect(failure.message).toContain('Box requirement "sh -c');
    expect(failure.message).toContain('[redacted]" failed');
    expect(failure.message).toContain("exit code 3: credential [redacted] was rejected");
    expect(failure.message).not.toContain("trusted-host-secret");
  });

  it("reports trusted-host requirement errors without exposing Home file contents", async () => {
    const box = await resolveBox(
      {
        home: { files: { ".acme/token": { contents: "file-backed-secret\n" } } },
        requires: [{
          command: "sh",
          args: ["-c", 'cat "$HOME/.acme/token" >&2; exit 3'],
        }],
        runtime: createTrustedHostRuntime(),
      },
      {},
    );

    const failure = await boxProvider(box).createSession()
      .catch((error: unknown) => error as Error) as Error;
    expect(failure.message).toContain("exit code 3: [redacted]");
    expect(failure.message).not.toContain("file-backed-secret");
  });

  it("bounds trusted-host requirement checks with their configured timeout", async () => {
    const box = await resolveBox(
      {
        requires: [{
          command: process.execPath,
          args: [
            "-e",
            "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
          ],
          timeout: 20,
        }],
        runtime: createTrustedHostRuntime(),
      },
      {},
    );

    await expect(boxProvider(box).createSession()).rejects.toThrow("timed out after 20ms");
  });

  it("suppresses requirement output when durable Home state is mounted", async () => {
    const root = await temporaryRoot();
    const box = await resolveBox(
      {
        home: {
          state: {
            ".acme": {
              key: "requirement-diagnostic-state",
              seed: { token: { contents: "durable-state-secret" } },
            },
          },
        },
        requires: [{
          command: "sh",
          args: ["-c", 'cat "$HOME/.acme/token" >&2; exit 3'],
        }],
        runtime: createTrustedHostRuntime({ stateRoot: join(root, "state") }),
      },
      {},
    );

    const failure = await boxProvider(box).createSession()
      .catch((error: unknown) => error as Error) as Error;
    expect(failure.message).toContain("exit code 3");
    expect(failure.message).not.toContain("durable-state-secret");
  });

  it("resolves relative requirement executables from the Box workspace", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "bin"), { recursive: true });
    await executable(join(workspace, "bin"), "check", "exit 0");
    const box = await resolveBox(
      {
        cwd: workspace,
        requires: [{ command: "./bin/check", args: [] }],
        runtime: createTrustedHostRuntime(),
      },
      {},
    );

    const session = await boxProvider(box).createSession();
    await session.destroy?.();
  });

  it("rejects invalid targets and reserved environment variables", async () => {
    await expect(
      resolveBox(
        {
          home: { files: { "../auth.json": { contents: "secret" } } },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    ).rejects.toThrow("relative POSIX path");
    await expect(
      resolveBox(
        {
          env: { HOME: "/ambient" },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    ).rejects.toThrow("HOME is managed by the Box runtime");
    await expect(
      resolveBox(
        {
          env: { CODEX_HOME: "/ambient" },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    ).rejects.toThrow("CODEX_HOME is managed by the Box runtime");
    await expect(
      resolveBox(
        {
          home: {
            files: { ".config": { contents: "file" }, ".config/acme": { contents: "nested" } },
          },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    ).rejects.toThrow("home.files targets conflict");
    await expect(
      resolveBox(
        {
          home: {
            state: {
              ".first": { key: "shared" },
              ".second": { key: "shared" },
            },
          },
          runtime: createTrustedHostRuntime({ stateRoot: "/tmp/vitehub-duplicate-state-test" }),
        },
        {},
      ),
    ).rejects.toThrow("Box state keys must be unique");
    await expect(
      resolveBox(
        {
          home: {
            files: { ".acme/foo/bar": { contents: "static" } },
            state: {
              ".acme": {
                key: "seed-file-ancestor",
                seed: { foo: { contents: "seed" } },
              },
            },
          },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    ).rejects.toThrow("home.state .acme projected targets conflict");
    await expect(
      resolveBox(
        {
          home: {
            files: { ".acme/auth.json": { contents: "static" } },
            state: {
              ".acme": {
                key: "same-file",
                seed: { "auth.json": { contents: "seed" } },
              },
            },
          },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    ).rejects.toThrow("home.state .acme projected targets conflict");
    await expect(
      resolveBox(
        {
          home: {
            files: { ".acme/foo": { contents: "static" } },
            state: {
              ".acme": {
                key: "static-file-ancestor",
                seed: { "foo/bar": { contents: "seed" } },
              },
            },
          },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    ).rejects.toThrow("home.state .acme projected targets conflict");
  });

  it("preserves a caller-owned state root and resolves symlinked ancestors", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const stateRoot = join(root, "state");
    await Promise.all([mkdir(workspace), mkdir(stateRoot, { mode: 0o755 })]);
    await chmod(stateRoot, 0o755);

    const box = await resolveBox(
      {
        home: { state: { ".acme": { key: "portable-box-test/root-mode" } } },
        runtime: createTrustedHostRuntime({ stateRoot }),
      },
      {},
    );
    const session = await boxProvider(box).createSession();
    expect((await stat(stateRoot)).mode & 0o777).toBe(0o755);
    await session.destroy?.();

    const linkedRoot = join(root, "linked");
    await symlink(workspace, linkedRoot);
    await expect(
      resolveBox(
        {
          cwd: workspace,
          home: { state: { ".acme": { key: "portable-box-test/symlink-root" } } },
          runtime: createTrustedHostRuntime({ stateRoot: join(linkedRoot, "state") }),
        },
        {},
      ),
    ).rejects.toThrow("outside the authoritative workspace");
  });

  it("requires a durable root for writable state", async () => {
    await expect(
      resolveBox(
        {
          home: { state: { ".codex": { key: "codex" } } },
          runtime: createTrustedHostRuntime(),
        },
        {},
      ),
    ).rejects.toThrow("stateRoot");
    await expect(
      resolveBox(
        {
          home: { state: { ".codex": { key: "codex" } } },
          runtime: createTrustedHostRuntime({ stateRoot: "relative" }),
        },
        {},
      ),
    ).rejects.toThrow("absolute path");
  });
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "vitehub-box-test-"));
  roots.push(root);
  return root;
}

async function executable(bin: string, name: string, body: string) {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

const sessionWithEnv = {} as TestSession & {
  env: Record<string, string>;
};

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
