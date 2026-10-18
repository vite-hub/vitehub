import { describe, expect, it } from "vitest";

import { abortable } from "../src/internal/abortable.ts";

describe("abortable", () => {
  it("forwards promise settlement while the signal stays active", async () => {
    await expect(abortable(Promise.resolve("done"))).resolves.toBe("done");
    await expect(abortable(Promise.reject(new Error("failed")))).rejects.toThrow("failed");
  });

  it("rejects on abort without cancelling the underlying operation", async () => {
    let resolveOperation!: (value: string) => void;
    const operation = new Promise<string>((resolve) => { resolveOperation = resolve; });
    const controller = new AbortController();
    const reason = new Error("cancelled");

    const waiting = abortable(operation, controller.signal);
    controller.abort(reason);

    await expect(waiting).rejects.toBe(reason);
    resolveOperation("completed");
    await expect(operation).resolves.toBe("completed");
  });

  it("rejects immediately when the signal is already aborted", () => {
    const reason = new Error("already cancelled");
    const signal = AbortSignal.abort(reason);

    expect(() => abortable(Promise.resolve("done"), signal)).toThrow("already cancelled");
  });
});
