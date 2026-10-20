import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSandbox } from "../src/index.ts";
import { createTrustedHostRuntime } from "../src/internal/trusted-host.ts";

describe("SandboxSession", () => {
  it("rejects runtimes that do not declare execution authority", async () => {
    await expect(resolveSandbox({
      runtime: {
        name: "opaque",
        async open() { throw new Error("unreachable") },
        async prepare({ identity }) {
          // SAFETY: This invalid-runtime fixture supplies only the shape needed to reach authority validation.
          return {
            cache: { state: "disposable" },
            environment: { env: {} },
            identity,
            requirements: [],
            runtime: "opaque",
            workspace: { state: "disposable", workDir: "." },
          } as never
        },
      },
    }, {})).rejects.toThrow("must declare executionAuthority")
  })

  it("provides one binary-safe file contract", async () => {
    const sandbox = await resolveSandbox({ runtime: createTrustedHostRuntime() }, {});
    const session = await sandbox.open();

    try {
      await session.files.mkdir("workspace/nested", { recursive: true });
      await session.files.write("workspace/nested/data.bin", new Uint8Array([0, 1, 127, 255]));

      await expect(session.files.exists("workspace/nested/data.bin")).resolves.toBe(true);
      await expect(session.files.read("workspace/nested/data.bin")).resolves.toEqual(
        new Uint8Array([0, 1, 127, 255]),
      );
      await expect(session.files.list("workspace", { recursive: true })).resolves.toEqual([
        { path: "workspace/nested", size: undefined, type: "directory" },
        { path: "workspace/nested/data.bin", size: 4, type: "file" },
      ]);
      await expect(
        session.files.list("workspace", { exclude: ["/"], recursive: true }),
      ).resolves.toEqual([]);

      await session.files.move?.("workspace/nested/data.bin", "workspace/data.bin");
      await session.files.remove("workspace/nested");
      await expect(session.files.exists("workspace/data.bin")).resolves.toBe(true);
      await session.files.remove("workspace", { recursive: true });
      await expect(session.files.exists("workspace")).resolves.toBe(false);
    } finally {
      await session.close();
    }
  });

  it("executes with explicit cwd, environment, timeout, and cancellation", async () => {
    const sandbox = await resolveSandbox({ runtime: createTrustedHostRuntime() }, {});
    const session = await sandbox.open();

    try {
      await expect(
        session.exec(
          process.execPath,
          ["-e", "process.stdout.write(`${process.cwd()}|${process.env.SANDBOX_VALUE}`)"],
          { cwd: session.cwd, env: { SANDBOX_VALUE: "ready" } },
        ),
      ).resolves.toMatchObject({
        code: 0,
        ok: true,
        stdout: `${session.cwd}|ready`,
      });

      await expect(
        session.exec(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeout: 20 }),
      ).rejects.toThrow();

      await expect(
        session.exec("sh", ["-c", `trap '' TERM; sleep 600`], { timeout: 20 }),
      ).rejects.toThrow();

      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      await expect(session.exec("true", [], { signal: controller.signal })).rejects.toThrow(
        "cancelled",
      );
    } finally {
      await session.close();
    }
  });

  it("uses an authoritative workspace as the public and default cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vitehub-sandbox-workspace-"));
    await writeFile(join(workspace, "package.json"), "{}");
    const sandbox = await resolveSandbox({ cwd: workspace, runtime: createTrustedHostRuntime() }, {});
    const session = await sandbox.open();

    try {
      expect(await realpath(session.cwd)).toBe(await realpath(workspace));
      await expect(session.exec("test", ["-f", "package.json"])).resolves.toMatchObject({
        code: 0,
        ok: true,
      });
    } finally {
      await session.close();
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("advertises optional process and port capabilities and closes idempotently", async () => {
    const sandbox = await resolveSandbox({ runtime: createTrustedHostRuntime() }, {});
    const controller = new AbortController();
    const session = await sandbox.open({ id: "session-id", signal: controller.signal });

    expect(session.id).toBe("session-id");
    expect(session.spawn).toBeTypeOf("function");
    expect(session.ports).toBeDefined();
    await expect(session.ports!.expose(4321)).resolves.toEqual(
      new URL("http://127.0.0.1:4321"),
    );

    const processHandle = await session.spawn!(process.execPath, ["-e", "process.stdout.write('ok')"]);
    await expect(new Response(processHandle.stdout).text()).resolves.toBe("ok");
    await expect(processHandle.wait()).resolves.toEqual({ code: 0 });

    controller.abort(new Error("cancelled"));
    await expect(session.ports!.expose(4321)).rejects.toThrow("cancelled");

    await session.close();
    await session.close();
    await expect(session.files.exists("workspace")).rejects.toThrow("Sandbox session is closed");
    await expect(session.ports!.expose(4321)).rejects.toThrow("Sandbox session is closed");
    await expect(session.spawn!("true")).rejects.toThrow("Sandbox session is closed");
  });

  it("streams stdin to spawned processes", async () => {
    const sandbox = await resolveSandbox({ runtime: createTrustedHostRuntime() }, {});
    const session = await sandbox.open();

    try {
      const child = await session.spawn!(process.execPath, [
        "-e",
        "let text = ''; process.stdin.on('data', chunk => text += chunk); process.stdin.on('end', () => process.stdout.write(text.toUpperCase()))",
      ]);
      const stdin = child.stdin;
      expect(stdin).toBeDefined();
      const writer = stdin!.getWriter();
      await writer.write(new TextEncoder().encode("first\n"));
      await writer.write(new TextEncoder().encode("second\n"));
      await writer.close();

      await expect(new Response(child.stdout).text()).resolves.toBe("FIRST\nSECOND\n");
      await expect(child.wait()).resolves.toEqual({ code: 0 });
    } finally {
      await session.close();
    }
  });

  it("rolls back newly initialized state when initialization fails", async () => {
    let seeds = 0;
    const stateRoot = await mkdtemp(join(tmpdir(), "vitehub-sandbox-state-"));
    const sandbox = await resolveSandbox(
      {
        home: {
          state: {
            ".acme": {
              key: "sandbox-session-initialize",
              seed: { "value.txt": { contents: () => String(++seeds) } },
            },
          },
        },
        runtime: createTrustedHostRuntime({ stateRoot }),
      },
      {},
    );

    await expect(
      sandbox.open({
        async initialize() {
          throw new Error("initialization failed");
        },
      }),
    ).rejects.toThrow("initialization failed");

    const session = await sandbox.open();
    try {
      const result = await session.exec('cat "$HOME/.acme/value.txt"');
      expect(result.stdout).toBe("2");
    } finally {
      await session.close();
      await rm(stateRoot, { force: true, recursive: true });
    }
  });
});
