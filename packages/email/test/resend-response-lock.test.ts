import { afterEach, describe, expect, it, vi } from "vitest";

import resend from "../src/drivers/resend.ts";

const message = {
  from: "hello@example.com",
  to: "recipient@example.com",
  subject: "Hello",
  text: "Hello",
};
const context = { attempt: 1, driver: "resend", meta: {} };

afterEach(() => vi.useRealTimers());

describe("Resend response reader ownership", () => {
  it.each([200, 429])("releases a fully read HTTP %s response", async (status) => {
    const response = new Response(JSON.stringify({ id: "email-1" }), { status });
    const driver = resend({ apiKey: "re_test", fetch: async () => response });

    const result = await driver.send(message, context);

    if (status === 200) expect(result).toMatchObject([undefined, { id: "email-1" }]);
    else expect(result).toMatchObject([{ code: "RATE_LIMIT" }, undefined]);
    expect(response.body?.locked).toBe(false);
  });

  it("releases a response whose body read fails", async () => {
    const response = new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection reset")); },
    }));
    const driver = resend({ apiKey: "re_test", fetch: async () => response });

    await expect(driver.send(message, context)).resolves.toMatchObject([{ code: "NETWORK" }, undefined]);
    expect(response.body?.locked).toBe(false);
  });

  it("releases an oversized response", async () => {
    const response = new Response("x".repeat(65_537));
    const driver = resend({ apiKey: "re_test", fetch: async () => response });

    await expect(driver.send(message, context)).resolves.toMatchObject([{ code: "PROVIDER" }, undefined]);
    expect(response.body?.locked).toBe(false);
  });

  it.each(["before reading", "during reading"])("releases a response cancelled %s", async (when) => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const driver = resend({
      apiKey: "re_test",
      fetch: async () => {
        if (when === "before reading") controller.abort();
        return response;
      },
    });

    const delivery = driver.send(message, { ...context, signal: controller.signal });
    if (when === "during reading") {
      await vi.waitFor(() => expect(response.body?.locked).toBe(true));
      controller.abort();
    }

    await expect(delivery).resolves.toMatchObject([{ code: "CANCELLED" }, undefined]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each(["rejecting", "pending"])("releases a timed-out response with %s cancellation", async (behavior) => {
    vi.useFakeTimers();
    let finishCleanup = () => {};
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const cancel = vi.fn(() => behavior === "rejecting"
      ? Promise.reject(new Error("cancel failed"))
      : cleanup);
    const response = new Response(new ReadableStream({ cancel }));
    const driver = resend({ apiKey: "re_test", fetch: async () => response });

    try {
      const delivery = driver.send(message, context);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(delivery).resolves.toMatchObject([{ code: "TIMEOUT" }, undefined]);
      expect(cancel).toHaveBeenCalledOnce();
      expect(response.body?.locked).toBe(false);
    } finally {
      finishCleanup();
    }
  });
});
