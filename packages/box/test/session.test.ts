import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveBox, trustedHost } from "../src/index.ts";

describe("BoxSession", () => {
  it("provides one binary-safe file contract", async () => {
    const box = await resolveBox({ runtime: trustedHost() }, {});
    const session = await box.open();

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
    const box = await resolveBox({ runtime: trustedHost() }, {});
    const session = await box.open();

    try {
      await expect(
        session.exec(
          process.execPath,
          ["-e", "process.stdout.write(`${process.cwd()}|${process.env.BOX_VALUE}`)"],
          { cwd: session.cwd, env: { BOX_VALUE: "ready" } },
        ),
      ).resolves.toMatchObject({
        code: 0,
        ok: true,
        stdout: `${session.cwd}|ready`,
      });

      await expect(
        session.exec(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { timeout: 20 }),
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

  it("advertises optional process and port capabilities and closes idempotently", async () => {
    const box = await resolveBox({ runtime: trustedHost() }, {});
    const session = await box.open({ id: "session-id" });

    expect(session.id).toBe("session-id");
    expect(session.spawn).toBeTypeOf("function");
    expect(session.ports).toBeDefined();
    await expect(session.ports!.expose(4321)).resolves.toEqual(
      new URL("http://127.0.0.1:4321"),
    );

    const processHandle = await session.spawn!(process.execPath, ["-e", "process.stdout.write('ok')"]);
    await expect(new Response(processHandle.stdout).text()).resolves.toBe("ok");
    await expect(processHandle.wait()).resolves.toEqual({ code: 0 });

    await session.close();
    await session.close();
    await expect(session.files.exists("workspace")).rejects.toThrow("Box session is closed");
  });

  it("rolls back newly initialized state when initialization fails", async () => {
    let seeds = 0;
    const stateRoot = await mkdtemp(join(tmpdir(), "vitehub-box-state-"));
    const box = await resolveBox(
      {
        home: {
          state: {
            ".acme": {
              key: "box-session-initialize",
              seed: { "value.txt": { contents: () => String(++seeds) } },
            },
          },
        },
        runtime: trustedHost({ stateRoot }),
      },
      {},
    );

    await expect(
      box.open({
        async initialize() {
          throw new Error("initialization failed");
        },
      }),
    ).rejects.toThrow("initialization failed");

    const session = await box.open();
    try {
      const result = await session.exec('cat "$HOME/.acme/value.txt"');
      expect(result.stdout).toBe("2");
    } finally {
      await session.close();
      await rm(stateRoot, { force: true, recursive: true });
    }
  });
});
