import { describe, expect, it, vi } from "vitest";

import cloudflareEmail from "../src/drivers/cloudflare-email.ts";
import resend from "../src/drivers/resend.ts";
import { emailProviderError } from "../src/provider.ts";

import type { EmailMessage } from "../src/types.ts";
import type { ResendEmailDriverOptions } from "../src/drivers/resend.ts";

const message: EmailMessage = {
  attachments: [{ content: new Uint8Array([1, 2, 3]), filename: "report.bin" }],
  from: { email: "hello@example.com", name: "ViteHub" },
  headers: { "X-Trace-Id": "trace-1" },
  html: "<p>Hello</p>",
  replyTo: "support@example.com",
  subject: "Welcome",
  text: "Hello",
  to: ["maxi@example.com"],
};

const context = { attempt: 1, driver: "fixture", meta: {} };

describe("Resend Email driver", () => {
  it("rejects credentials that do not match Resend's API key shape", () => {
    expect(() => resend({ apiKey: "secret" })).toThrow("apiKey must start with 're_'");
  });

  it("rejects non-string API keys during configuration", () => {
    const options: ResendEmailDriverOptions = { apiKey: "re_secret" };
    Object.assign(options, { apiKey: 123 });
    expect(() => resend(options)).toThrow("apiKey must be a string");
  });

  it("rejects API keys with invalid header characters during configuration", () => {
    expect(() => resend({ apiKey: "re_secret\n" })).toThrow(
      "apiKey contains an invalid HTTP header character",
    );
  });

  it.each([
    "",
    "not a url",
    "ftp://api.resend.com",
    "https://user:pass@api.resend.com",
    "https://api.resend.com?token=secret",
    "https://api.resend.com#proxy",
  ])("rejects an invalid endpoint during configuration", (endpoint) => {
    expect(() => resend({ apiKey: "re_secret", endpoint })).toThrow(
      "endpoint must be a valid HTTP or HTTPS URL",
    );
  });

  it("normalizes trailing slashes in the endpoint", async () => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const driver = resend({
      apiKey: "re_secret",
      endpoint: "https://resend.example.test///",
      fetch: request,
    });

    await driver.send(message, context);

    expect(request).toHaveBeenCalledWith("https://resend.example.test/emails", expect.any(Object));
  });

  it("maps the portable message and returns the provider id", async () => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send(
        {
          ...message,
          idempotencyKey: "send-1",
          scheduledAt: new Date("2026-08-26T12:00:00.000Z"),
          tags: [{ name: "kind", value: "welcome" }],
        },
        context,
      ),
    ).resolves.toMatchObject({
      data: { driver: "resend", id: "email-1" },
      error: null,
    });
    const [url, init = {}] = request.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({
      authorization: "Bearer re_secret",
      "Idempotency-Key": "send-1",
    });
    // SAFETY: the successful request assertion above proves the body was serialized as JSON text.
    expect(JSON.parse(init.body as string)).toMatchObject({
      attachments: [{ content: "AQID", filename: "report.bin" }],
      from: '"ViteHub" <hello@example.com>',
      reply_to: ["support@example.com"],
      scheduled_at: "2026-08-26T12:00:00.000Z",
      tags: [{ name: "kind", value: "welcome" }],
      to: ["maxi@example.com"],
    });
  });

  it("encodes string attachments as UTF-8 base64", async () => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await driver.send(
      { ...message, attachments: [{ content: "hello", filename: "hello.txt" }] },
      context,
    );

    // SAFETY: the successful Resend request stores its serialized JSON body in this call.
    expect(JSON.parse(request.mock.calls[0]![1]?.body as string).attachments).toEqual([
      { content: "aGVsbG8=", filename: "hello.txt" },
    ]);
  });

  it.each([
    [
      { html: "", text: "Hello" },
      { html: "", text: "Hello" },
    ],
    [
      { html: "<p>Hello</p>", text: "" },
      { html: "<p>Hello</p>", text: "" },
    ],
  ])("preserves explicitly empty body alternatives", async (body, expected) => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await driver.send({ ...message, ...body }, context);

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject(expected);
  });

  it("does not retry an ambiguous response body failure without idempotency", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
      { status: 200 },
    );
    const driver = resend({ apiKey: "re_secret", fetch: async () => response });

    await expect(driver.send(message, context)).resolves.toMatchObject({
      error: { code: "NETWORK", retryable: false },
    });
  });

  it.each([
    [408, "TIMEOUT", false, undefined],
    [500, "NETWORK", false, undefined],
    [408, "TIMEOUT", true, "send-1"],
    [500, "NETWORK", true, "send-1"],
    [429, "RATE_LIMIT", true, undefined],
  ])(
    "reports HTTP %i as %s with safe retryability",
    async (status, code, retryable, idempotencyKey) => {
      const driver = resend({
        apiKey: "re_secret",
        fetch: async () => new Response("{}", { status }),
      });

      await expect(driver.send({ ...message, idempotencyKey }, context)).resolves.toMatchObject({
        error: { code, retryable },
      });
    },
  );

  it("omits empty optional recipient lists", async () => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await driver.send({ ...message, bcc: [], cc: [], replyTo: [] }, context);

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).not.toMatchObject({
      bcc: [],
      cc: [],
      reply_to: [],
    });
  });

  it("rejects empty attachment filenames before fetch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send({ ...message, attachments: [{ content: "hello", filename: "  " }] }, context),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS" } });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["", "   "])(
    "rejects an empty attachment content type %j before fetch",
    async (contentType) => {
      const request = vi.fn();
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(
        driver.send(
          { ...message, attachments: [{ content: "hello", contentType, filename: "report.txt" }] },
          context,
        ),
      ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    [undefined, false],
    ["send-1", true],
  ])(
    "reports ambiguous request failures as retryable only with idempotency",
    async (idempotencyKey, retryable) => {
      const driver = resend({
        apiKey: "re_secret",
        fetch: async () => {
          throw new Error("connection reset");
        },
      });

      await expect(driver.send({ ...message, idempotencyKey }, context)).resolves.toMatchObject({
        error: { code: "NETWORK", retryable },
      });
    },
  );

  it("cancels and times out a stalled response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const driver = resend({ apiKey: "re_secret", fetch: async () => response });

    const delivery = driver.send(message, context);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(delivery).resolves.toMatchObject({ error: { code: "TIMEOUT", retryable: false } });
    expect(cancel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("applies one deadline to the complete response body", async () => {
    vi.useFakeTimers();
    const response = new Response(
      new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          controller.enqueue(new Uint8Array([1]));
        },
      }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: async () => response });

    const delivery = driver.send(message, context);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(delivery).resolves.toMatchObject({ error: { code: "TIMEOUT", retryable: false } });
    vi.useRealTimers();
  });

  it.each(["rejecting", "pending"])(
    "does not wait for %s response cancellation",
    async (behavior) => {
      vi.useFakeTimers();
      const cancel = vi.fn(() =>
        behavior === "rejecting"
          ? Promise.reject(new Error("cancel failed"))
          : new Promise<void>(() => {}),
      );
      const response = new Response(new ReadableStream({ cancel }));
      const driver = resend({ apiKey: "re_secret", fetch: async () => response });

      const delivery = driver.send(message, context);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(delivery).resolves.toMatchObject({
        error: { code: "TIMEOUT", retryable: false },
      });
      expect(cancel).toHaveBeenCalledOnce();
      vi.useRealTimers();
    },
  );

  it.each([
    [undefined, false],
    ["send-1", true],
  ])(
    "aborts a stalled request and reports idempotency-safe retryability",
    async (idempotencyKey, retryable) => {
      vi.useFakeTimers();
      const request = vi.fn(
        (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const driver = resend({ apiKey: "re_secret", fetch: request });

      const delivery = driver.send({ ...message, idempotencyKey }, context);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(delivery).resolves.toMatchObject({ error: { code: "TIMEOUT", retryable } });
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      vi.useRealTimers();
    },
  );

  it("retries an ambiguous response timeout with idempotency", async () => {
    vi.useFakeTimers();
    const response = new Response(new ReadableStream());
    const driver = resend({ apiKey: "re_secret", fetch: async () => response });

    const delivery = driver.send({ ...message, idempotencyKey: "send-1" }, context);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(delivery).resolves.toMatchObject({ error: { code: "TIMEOUT", retryable: true } });
    vi.useRealTimers();
  });

  it("applies unsubscribe headers when called directly", async () => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await driver.send(
      {
        ...message,
        unsubscribe: { mailto: "leave@example.com", url: "https://example.com/unsubscribe" },
      },
      context,
    );

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).headers).toMatchObject({
      "List-Unsubscribe": "<https://example.com/unsubscribe>, <mailto:leave@example.com>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("serializes the validated unsubscribe URL", async () => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await driver.send(
      { ...message, unsubscribe: { url: "https://example.com/un subscribe" } },
      context,
    );

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      headers: { "List-Unsubscribe": "<https://example.com/un%20subscribe>" },
    });
  });

  it.each(["not address", "a>, <https://evil.test>", "leave\u0000@example.com"])(
    "rejects an invalid unsubscribe mailto target %j before dispatch",
    async (mailto) => {
      const request = vi.fn();
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(
        driver.send({ ...message, unsubscribe: { mailto } }, context),
      ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("rejects one-click unsubscribe when a custom header omits its HTTPS target", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send(
        {
          ...message,
          headers: { "List-Unsubscribe": "<mailto:leave@example.com>" },
          unsubscribe: { url: "https://example.com/unsubscribe" },
        },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a custom unsubscribe header that omits a configured non-one-click target", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send(
        {
          ...message,
          headers: { "List-Unsubscribe": "<mailto:other@example.com>" },
          unsubscribe: { mailto: "leave@example.com", oneClick: false },
        },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["", "List-Unsubscribe=No"])(
    "rejects an invalid one-click unsubscribe post header %j before dispatch",
    async (post) => {
      const request = vi.fn();
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(
        driver.send(
          {
            ...message,
            headers: {
              "List-Unsubscribe": "<https://example.com/unsubscribe>",
              "List-Unsubscribe-Post": post,
            },
            unsubscribe: { url: "https://example.com/unsubscribe" },
          },
          context,
        ),
      ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      headers: {
        "List-Unsubscribe": "<https://example.com/unsubscribe>",
        "LIST-UNSUBSCRIBE-POST": "List-Unsubscribe=One-Click",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      unsubscribe: { url: "https://example.com/unsubscribe" },
    },
    {
      headers: {
        "List-Unsubscribe": "<http://example.com/unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      unsubscribe: { oneClick: false, url: "http://example.com/unsubscribe" },
    },
  ])("rejects ambiguous one-click headers before dispatch", async (options) => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send({ ...message, ...options } as typeof message, context),
    ).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "resend" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects one-click unsubscribe without a URL before dispatch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send(
        { ...message, unsubscribe: { mailto: "leave@example.com", oneClick: true } },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS" } });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["   ", "not a URL", "http://example.com/unsubscribe"])(
    "rejects an invalid one-click unsubscribe URL %j before dispatch",
    async (url) => {
      const request = vi.fn();
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(
        driver.send({ ...message, unsubscribe: { oneClick: true, url } }, context),
      ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["not a URL", "http://example.com/unsubscribe"])(
    "rejects an invalid implicit one-click unsubscribe URL %j before dispatch",
    async (url) => {
      const request = vi.fn();
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(
        driver.send({ ...message, unsubscribe: { url } }, context),
      ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["   ", "not a URL"])(
    "rejects an invalid non-one-click unsubscribe URL %j before dispatch",
    async (url) => {
      const request = vi.fn();
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(
        driver.send({ ...message, unsubscribe: { oneClick: false, url } }, context),
      ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("allows non-HTTPS unsubscribe URLs when one-click is disabled", async () => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await driver.send(
      {
        ...message,
        unsubscribe: { oneClick: false, url: "http://example.com/un subscribe" },
      },
      context,
    );

    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      headers: { "List-Unsubscribe": "<http://example.com/un%20subscribe>" },
    });
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).headers).not.toHaveProperty(
      "List-Unsubscribe-Post",
    );
  });

  it("cancels and rejects an oversized response body", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        cancel,
        start(controller) {
          controller.enqueue(new Uint8Array(64 * 1024 + 1));
        },
      }),
      { status: 200 },
    );
    const driver = resend({ apiKey: "re_secret", fetch: async () => response });

    await expect(driver.send(message, context)).resolves.toMatchObject({
      error: { code: "PROVIDER", retryable: undefined },
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not dispatch a pre-aborted send", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send(message, { ...context, signal: controller.signal }),
    ).resolves.toMatchObject({
      error: { code: "CANCELLED", driver: "resend", retryable: false },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps caller cancellation connected through the response body", async () => {
    const controller = new AbortController();
    const response = new Response(new ReadableStream());
    const driver = resend({ apiKey: "re_secret", fetch: async () => response });

    const delivery = driver.send(message, { ...context, signal: controller.signal });
    controller.abort();

    await expect(delivery).resolves.toMatchObject({
      error: { code: "CANCELLED", driver: "resend", retryable: false },
    });
  });

  it.each(["request", "response"] as const)(
    "classifies a provider-shaped %s abort reason as cancellation",
    async (phase) => {
      const controller = new AbortController();
      const reason = emailProviderError("foreign", "NETWORK", "Prior delivery failed.", {
        retryable: true,
      });
      const request = async (
        _input: Parameters<typeof fetch>[0],
        init?: RequestInit,
      ): Promise<Response> => {
        if (phase === "response") {
          queueMicrotask(() => controller.abort(reason));
          return new Response(new ReadableStream());
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
          queueMicrotask(() => controller.abort(reason));
        });
      };
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(
        driver.send(message, { ...context, signal: controller.signal }),
      ).resolves.toMatchObject({
        error: { code: "CANCELLED", driver: "resend", retryable: false },
      });
    },
  );

  it("rejects invalid idempotency header values before fetch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send({ ...message, idempotencyKey: "invalid\nvalue" }, context),
    ).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "resend" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an empty primary recipient list before delivery", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send({ ...message, to: [], cc: ["copy@example.com"] }, context),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { from: "" },
    { from: { email: "   " } },
    { to: "   " },
    { to: [{ email: "" }] },
    { cc: ["   "] },
    { bcc: [{ email: " " }] },
    { replyTo: "" },
  ])("rejects blank mailbox values before fetch", async (override) => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(driver.send({ ...message, ...override }, context)).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "resend" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "x".repeat(257)])(
    "rejects an out-of-range idempotency key before fetch",
    async (idempotencyKey) => {
      const request = vi.fn();
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(driver.send({ ...message, idempotencyKey }, context)).resolves.toMatchObject({
        error: { code: "INVALID_OPTIONS", driver: "resend" },
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["x", "x".repeat(256)])(
    "accepts an idempotency key at the supported boundaries",
    async (idempotencyKey) => {
      const request = vi.fn(
        async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
          new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
      );
      const driver = resend({ apiKey: "re_secret", fetch: request });

      await expect(driver.send({ ...message, idempotencyKey }, context)).resolves.toMatchObject({
        error: null,
      });
      expect(request.mock.calls[0]![1]?.headers).toMatchObject({
        "Idempotency-Key": idempotencyKey,
      });
    },
  );

  it("rejects raw message payloads before fetch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send({ ...message, raw: "From: hello@example.com\r\n\r\nHello" }, context),
    ).resolves.toMatchObject({
      error: { code: "UNSUPPORTED", driver: "resend" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects template payloads before fetch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send({ ...message, template: { id: "welcome" } }, context),
    ).resolves.toMatchObject({
      error: { code: "UNSUPPORTED", driver: "resend" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["tracking preferences", { tracking: { opens: false } }],
    ["AMP content", { amp: "<html amp4email>" }],
    ["DSN options", { dsn: { notify: ["FAILURE"] } }],
    ["preheaders", { preheader: "Preview" }],
    ["locales", { locale: "en" }],
  ])("rejects unsupported %s before fetch", async (_name, unsupported) => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      // SAFETY: this table contains public EmailMessage option fragments for runtime rejection tests.
      driver.send({ ...message, ...unsupported } as typeof message, context),
    ).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "resend" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects stream selection before fetch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send(message, { ...context, stream: "transactional" }),
    ).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "resend" } });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { react: {} },
    { jsx: {} },
    { mjml: "<mjml />" },
    { handlebars: "Hello {{name}}" },
    { handlebarsVars: { name: "Maxi" } },
    { liquid: "Hello {{ name }}" },
    { liquidVars: { name: "Maxi" } },
  ])("rejects unsupported renderer payloads before fetch", async (renderer) => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(driver.send({ ...message, ...renderer }, context)).resolves.toMatchObject({
      error: { code: "UNSUPPORTED", driver: "resend" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects unsupported personalizations before fetch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send(
        { ...message, personalizations: [{ to: "one@example.com" }, { to: "two@example.com" }] },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "resend" } });
    await expect(
      driver.send(
        { ...message, personalizations: [{ to: "one@example.com", variables: { name: "One" } }] },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "resend" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("applies one address and subject personalization", async () => {
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await driver.send(
      { ...message, personalizations: [{ subject: "Personal welcome", to: "one@example.com" }] },
      context,
    );

    // SAFETY: the successful Resend request stores its serialized JSON body in this call.
    expect(JSON.parse(request.mock.calls[0]![1]?.body as string)).toMatchObject({
      subject: "Personal welcome",
      to: ["one@example.com"],
    });
  });

  it("rejects an invalid scheduled date without making a request", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(
      driver.send({ ...message, scheduledAt: new Date("invalid") }, context),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "resend" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an empty schedule before fetch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(driver.send({ ...message, scheduledAt: "" }, context)).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "resend" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects sandbox delivery before fetch", async () => {
    const request = vi.fn();
    const driver = resend({ apiKey: "re_secret", fetch: request });

    await expect(driver.send({ ...message, sandbox: true }, context)).resolves.toMatchObject({
      error: { code: "UNSUPPORTED", driver: "resend" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [401, "AUTH"],
    [408, "TIMEOUT"],
    [429, "RATE_LIMIT"],
    [500, "NETWORK"],
    [400, "PROVIDER"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    const driver = resend({
      apiKey: "re_secret",
      fetch: async () => new Response(JSON.stringify({ message: "failed" }), { status }),
    });
    await expect(driver.send(message, context)).resolves.toMatchObject({
      error: { code, driver: "resend", status },
    });
  });

  it.each([200, 400])("handles a JSON null response with HTTP %s", async (status) => {
    const driver = resend({
      apiKey: "re_secret",
      fetch: async () => new Response("null", { status }),
    });
    await expect(driver.send(message, context)).resolves.toMatchObject({
      data: null,
      error: { code: "PROVIDER", driver: "resend" },
    });
  });

  it.each(["", "   "])("rejects an empty message id in a successful response", async (id) => {
    const driver = resend({
      apiKey: "re_secret",
      fetch: async () => new Response(JSON.stringify({ id }), { status: 200 }),
    });
    await expect(driver.send(message, context)).resolves.toMatchObject({
      data: null,
      error: { code: "PROVIDER", driver: "resend" },
    });
  });
});

describe("Cloudflare Email driver", () => {
  it("applies unsubscribe headers when called directly", async () => {
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

    await driver.send(
      {
        ...message,
        unsubscribe: { mailto: "leave@example.com", url: "https://example.com/unsubscribe" },
      },
      context,
    );

    expect(Constructor.mock.calls[0]?.[2]).toContain(
      "List-Unsubscribe: <https://example.com/unsubscribe>, <mailto:leave@example.com>",
    );
    expect(Constructor.mock.calls[0]?.[2]).toContain(
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    );
  });

  it("serializes the validated unsubscribe URL", async () => {
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

    await driver.send(
      { ...message, unsubscribe: { url: "https://example.com/un subscribe" } },
      context,
    );

    expect(String(Constructor.mock.calls[0]?.[2])).toContain(
      "List-Unsubscribe: <https://example.com/un%20subscribe>",
    );
  });

  it.each(["not address", "a>, <https://evil.test>", "leave\u0000@example.com"])(
    "rejects an invalid unsubscribe mailto target %j before delivery",
    async (mailto) => {
      const send = vi.fn();
      const Constructor = vi.fn();
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

      await expect(
        driver.send({ ...message, unsubscribe: { mailto } }, context),
      ).resolves.toMatchObject({
        error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
      });
      expect(Constructor).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("rejects one-click unsubscribe when a custom header omits its HTTPS target", async () => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send(
        {
          ...message,
          headers: { "List-Unsubscribe": "<mailto:leave@example.com>" },
          unsubscribe: { url: "https://example.com/unsubscribe" },
        },
        context,
      ),
    ).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
    });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a custom unsubscribe header that omits a configured non-one-click target", async () => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send(
        {
          ...message,
          headers: { "List-Unsubscribe": "<mailto:other@example.com>" },
          unsubscribe: { mailto: "leave@example.com", oneClick: false },
        },
        context,
      ),
    ).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
    });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["", "List-Unsubscribe=No"])(
    "rejects an invalid one-click unsubscribe post header %j before delivery",
    async (post) => {
      const send = vi.fn();
      const Constructor = vi.fn();
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

      await expect(
        driver.send(
          {
            ...message,
            headers: {
              "List-Unsubscribe": "<https://example.com/unsubscribe>",
              "List-Unsubscribe-Post": post,
            },
            unsubscribe: { url: "https://example.com/unsubscribe" },
          },
          context,
        ),
      ).resolves.toMatchObject({
        error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
      });
      expect(Constructor).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      headers: {
        "List-Unsubscribe": "<https://example.com/unsubscribe>",
        "LIST-UNSUBSCRIBE-POST": "List-Unsubscribe=One-Click",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      unsubscribe: { url: "https://example.com/unsubscribe" },
    },
    {
      headers: {
        "List-Unsubscribe": "<http://example.com/unsubscribe>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      unsubscribe: { oneClick: false, url: "http://example.com/unsubscribe" },
    },
  ])("rejects ambiguous one-click headers before delivery", async (options) => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send({ ...message, ...options } as typeof message, context),
    ).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
    });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects one-click unsubscribe without a URL before delivery", async () => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send(
        { ...message, unsubscribe: { mailto: "leave@example.com", oneClick: true } },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS" } });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["   ", "not a URL", "http://example.com/unsubscribe"])(
    "rejects an invalid one-click unsubscribe URL %j before delivery",
    async (url) => {
      const send = vi.fn();
      const Constructor = vi.fn();
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

      await expect(
        driver.send({ ...message, unsubscribe: { oneClick: true, url } }, context),
      ).resolves.toMatchObject({
        error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
      });
      expect(Constructor).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["not a URL", "http://example.com/unsubscribe"])(
    "rejects an invalid implicit one-click unsubscribe URL %j before delivery",
    async (url) => {
      const send = vi.fn();
      const Constructor = vi.fn();
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

      await expect(
        driver.send({ ...message, unsubscribe: { url } }, context),
      ).resolves.toMatchObject({
        error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
      });
      expect(Constructor).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["   ", "not a URL"])(
    "rejects an invalid non-one-click unsubscribe URL %j before delivery",
    async (url) => {
      const send = vi.fn();
      const Constructor = vi.fn();
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

      await expect(
        driver.send({ ...message, unsubscribe: { oneClick: false, url } }, context),
      ).resolves.toMatchObject({
        error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
      });
      expect(Constructor).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("allows non-HTTPS unsubscribe URLs when one-click is disabled", async () => {
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

    await driver.send(
      {
        ...message,
        unsubscribe: { oneClick: false, url: "http://example.com/un subscribe" },
      },
      context,
    );

    expect(String(Constructor.mock.calls[0]?.[2])).toContain(
      "List-Unsubscribe: <http://example.com/un%20subscribe>",
    );
    expect(String(Constructor.mock.calls[0]?.[2])).not.toContain("List-Unsubscribe-Post:");
  });

  it("rejects stream selection before delivery", async () => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send(message, { ...context, stream: "transactional" }),
    ).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "cloudflare-email" } });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("omits empty optional recipient headers", async () => {
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

    await driver.send({ ...message, cc: [], replyTo: [] }, context);

    expect(Constructor.mock.calls[0]?.[2]).not.toContain("\r\nCc:");
    expect(Constructor.mock.calls[0]?.[2]).not.toContain("\r\nReply-To:");
  });

  it("rejects empty attachment filenames before delivery", async () => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send({ ...message, attachments: [{ content: "hello", filename: "  " }] }, context),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS" } });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["", "   "])(
    "rejects an empty attachment content type %j before delivery",
    async (contentType) => {
      const send = vi.fn();
      const Constructor = vi.fn();
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

      await expect(
        driver.send(
          { ...message, attachments: [{ content: "hello", contentType, filename: "report.txt" }] },
          context,
        ),
      ).resolves.toMatchObject({
        error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
      });
      expect(Constructor).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("rejects multiple personalizations before delivery", async () => {
    const send = vi.fn();
    const Constructor = vi.fn();
    // SAFETY: this mock constructor deliberately omits the runtime constructor signature.
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor as never });

    await expect(
      driver.send(
        { ...message, personalizations: [{ to: "one@example.com" }, { to: "two@example.com" }] },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "cloudflare-email" } });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an empty primary recipient list before delivery", async () => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send({ ...message, to: [], cc: ["copy@example.com"] }, context),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { from: "" },
    { from: { email: "   " } },
    { to: "   " },
    { to: [{ email: "" }] },
    { cc: ["   "] },
    { bcc: [{ email: " " }] },
    { replyTo: "" },
  ])("rejects blank mailbox values before delivery", async (override) => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(driver.send({ ...message, ...override }, context)).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
    });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("constructs raw MIME and sends it through the binding", async () => {
    const send = vi.fn();
    const Constructor = vi.fn(function (
      this: Record<string, unknown>,
      from: string,
      to: string,
      raw: string,
    ) {
      Object.assign(this, { from, raw, to });
    });
    // SAFETY: this test constructor implements the required runtime constructor behavior.
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor as never });

    await expect(driver.send(message, context)).resolves.toMatchObject({
      data: { driver: "cloudflare-email" },
      error: null,
    });
    expect(Constructor).toHaveBeenCalledWith(
      "hello@example.com",
      "maxi@example.com",
      expect.stringContaining("Content-Type: multipart/mixed"),
    );
    expect(Constructor.mock.calls[0]![2]).toContain("AQID");
    expect(Constructor.mock.calls[0]![2]).toContain("Content-Type: multipart/alternative");
    expect(Constructor.mock.calls[0]![2]).toContain("Content-Type: text/plain; charset=utf-8");
    expect(Constructor.mock.calls[0]![2]).toContain("Content-Type: text/html; charset=utf-8");
    expect(Constructor.mock.calls[0]![2]).toMatch(
      /\r\nDate: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT\r\n/,
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("quotes and escapes display names for both built-in drivers", async () => {
    const namedMessage = { ...message, from: { email: "jane@example.com", name: 'Doe, "Jane"' } };
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    await resend({ apiKey: "re_secret", fetch: request }).send(namedMessage, context);
    // SAFETY: the successful Resend request stores its serialized JSON body in this call.
    expect(JSON.parse(request.mock.calls[0]![1]?.body as string).from).toBe(
      '"Doe, \\"Jane\\"" <jane@example.com>',
    );

    const Constructor = vi.fn();
    await cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor }).send(
      namedMessage,
      context,
    );
    expect(Constructor.mock.calls[0]![2]).toContain('From: "Doe, \\"Jane\\"" <jane@example.com>');
  });

  it("normalizes syntax quotes in string display names", async () => {
    const quotedMessage = { ...message, from: '"Doe, Jane" <jane@example.com>' };
    const request = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init: RequestInit = {}) =>
        new Response(JSON.stringify({ id: "email-1" }), { status: 200 }),
    );
    await resend({ apiKey: "re_secret", fetch: request }).send(quotedMessage, context);
    // SAFETY: the successful Resend request stores its serialized JSON body in this call.
    expect(JSON.parse(request.mock.calls[0]![1]?.body as string).from).toBe(
      '"Doe, Jane" <jane@example.com>',
    );

    const Constructor = vi.fn();
    await cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor }).send(
      quotedMessage,
      context,
    );
    expect(Constructor.mock.calls[0]![2]).toContain('From: "Doe, Jane" <jane@example.com>');
  });

  it("rejects multiple envelope recipients before sending", async () => {
    const send = vi.fn();
    const Constructor = vi.fn(function (
      this: Record<string, unknown>,
      from: string,
      to: string,
      raw: string,
    ) {
      Object.assign(this, { from, raw, to });
    });
    // SAFETY: this test constructor implements the required runtime constructor behavior.
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor as never });

    await expect(
      driver.send(
        {
          ...message,
          bcc: "audit@example.com",
          cc: { email: "reviewer@example.com", name: "Reviewer" },
          to: ["maxi@example.com", "team@example.com"],
        },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "cloudflare-email" } });

    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("encodes string attachments as UTF-8 base64", async () => {
    const send = vi.fn();
    const Constructor = vi.fn(function (
      this: Record<string, unknown>,
      from: string,
      to: string,
      raw: string,
    ) {
      Object.assign(this, { from, raw, to });
    });
    // SAFETY: this test constructor implements the required runtime constructor behavior.
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor as never });

    await driver.send(
      { ...message, attachments: [{ content: "hello", filename: "hello.txt" }] },
      context,
    );

    expect(Constructor.mock.calls[0]![2]).toContain("aGVsbG8=");
  });

  it.each([
    ["text", "Gr\u00fc\u00dfe", "text/plain"],
    ["html", "<p>Gr\u00fc\u00dfe</p>", "text/html"],
  ] as const)("base64-encodes attached UTF-8 %s bodies", async (field, content, contentType) => {
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

    await driver.send({ ...message, html: undefined, text: undefined, [field]: content }, context);

    // SAFETY: the Cloudflare Email constructor receives the generated raw MIME string as argument 3.
    const raw = Constructor.mock.calls[0]![2] as string;
    expect(raw).toContain(
      `Content-Type: ${contentType}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(content).toString("base64")}`,
    );
  });

  it("folds long message bodies into transport-safe lines", async () => {
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

    await driver.send(
      { ...message, attachments: undefined, html: undefined, text: "x".repeat(1000) },
      context,
    );

    // SAFETY: the Cloudflare Email constructor receives the generated raw MIME string as argument 3.
    const raw = Constructor.mock.calls[0]![2] as string;
    const encoded = raw.split("Content-Transfer-Encoding: base64\r\n\r\n")[1] ?? "";
    expect(encoded.split("\r\n").every((line) => line.length <= 76)).toBe(true);
  });

  it.each(["first\nsecond", "first\rsecond", "first\r\nsecond"])(
    "canonicalizes body newlines before transfer encoding",
    async (text) => {
      const Constructor = vi.fn();
      const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

      await driver.send(
        { ...message, attachments: undefined, html: undefined, scheduledAt: undefined, text },
        context,
      );

      const raw = Constructor.mock.calls[0]?.[2];
      expect(raw).toEqual(expect.any(String));
      const encoded = String(raw).split("Content-Transfer-Encoding: base64\r\n\r\n")[1] ?? "";
      expect(Buffer.from(encoded.replaceAll("\r\n", ""), "base64").toString()).toBe(
        "first\r\nsecond",
      );
    },
  );

  it("rejects scheduled delivery before sending", async () => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send({ ...message, scheduledAt: new Date("2026-08-26T12:00:00.000Z") }, context),
    ).resolves.toMatchObject({ error: { code: "UNSUPPORTED", driver: "cloudflare-email" } });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted send before Cloudflare delivery", async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send(message, { ...context, signal: controller.signal }),
    ).resolves.toMatchObject({
      error: { code: "CANCELLED", driver: "cloudflare-email", retryable: false },
    });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("reports the Cloudflare delivery outcome after dispatch despite cancellation", async () => {
    const controller = new AbortController();
    let resolveSend: (() => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    const delivery = driver.send(message, { ...context, signal: controller.signal });
    expect(send).toHaveBeenCalledOnce();
    controller.abort();
    resolveSend?.();

    await expect(delivery).resolves.toMatchObject({
      data: { driver: "cloudflare-email" },
      error: null,
    });
  });

  const unsupportedCloudflareOptions: [string, Partial<EmailMessage>][] = [
    ["raw message payloads", { raw: "From: hello@example.com\r\n\r\nHello" }],
    ["idempotency keys", { idempotencyKey: "send-1" }],
    ["sandbox delivery", { sandbox: true }],
    ["template payloads", { template: { id: "welcome" } }],
    ["React renderer payloads", { react: {} }],
    ["JSX renderer payloads", { jsx: {} }],
    ["MJML renderer payloads", { mjml: "<mjml />" }],
    ["Handlebars renderer payloads", { handlebars: "Hello {{name}}" }],
    ["Handlebars variables", { handlebarsVars: { name: "Maxi" } }],
    ["Liquid renderer payloads", { liquid: "Hello {{ name }}" }],
    ["Liquid variables", { liquidVars: { name: "Maxi" } }],
    ["tracking preferences", { tracking: { opens: false } }],
    ["AMP content", { amp: "<html amp4email>" }],
    ["DSN options", { dsn: { notify: ["FAILURE"] } }],
    ["preheaders", { preheader: "Preview" }],
    ["locales", { locale: "en" }],
    ["tags", { tags: [{ name: "kind", value: "welcome" }] }],
    ["metadata", { metadata: { campaign: "welcome" } }],
  ];

  it.each(unsupportedCloudflareOptions)(
    "rejects unsupported %s before sending",
    async (_name, unsupported) => {
      const send = vi.fn();
      const Constructor = vi.fn();
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

      await expect(driver.send({ ...message, ...unsupported }, context)).resolves.toMatchObject({
        error: { code: "UNSUPPORTED", driver: "cloudflare-email" },
      });
      expect(Constructor).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([
    { headers: { "X-Long": "x".repeat(1000) }, subject: "Welcome" },
    { headers: undefined, subject: "x".repeat(1000) },
  ])("rejects overlong raw headers", async ({ headers, subject }) => {
    const send = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() });

    await expect(
      driver.send({ ...message, headers, scheduledAt: undefined, subject }, context),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("preserves a case-insensitive custom message ID", async () => {
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

    await expect(
      driver.send({ ...message, headers: { "message-id": "<stable@example.com>" } }, context),
    ).resolves.toMatchObject({ data: { id: "<stable@example.com>" }, error: null });
    expect(Constructor.mock.calls[0]![2]).toContain("Message-ID: <stable@example.com>");
  });

  it("rejects an empty custom message ID before delivery", async () => {
    const send = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() });

    await expect(
      driver.send({ ...message, headers: { "message-id": "  " } }, context),
    ).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "not-a-msg-id",
    "<missing-domain@>",
    "<two@@example.com>",
    "<a..b@example.com>",
    "<a:b@example.com>",
    "<.leading@example.com>",
    "<trailing.@example.com>",
  ])("rejects malformed custom message ID %s before delivery", async (id) => {
    const send = vi.fn();
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: Constructor });

    await expect(
      driver.send({ ...message, headers: { "message-id": id } }, context),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS" } });
    expect(Constructor).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("folds attachment base64 and escapes quoted filenames", async () => {
    const Constructor = vi.fn();
    const driver = cloudflareEmail({ binding: { send: vi.fn() }, EmailMessage: Constructor });

    await driver.send(
      {
        ...message,
        attachments: [{ content: new Uint8Array(120), filename: 'report\\"final.pdf' }],
      },
      context,
    );

    // SAFETY: the Cloudflare Email constructor receives the generated raw MIME string as argument 3.
    const raw = Constructor.mock.calls[0]![2] as string;
    expect(raw).toContain('filename="report\\\\\\"final.pdf"');
    const encoded =
      raw.match(
        /Content-Transfer-Encoding: base64\r\nContent-Disposition: [^\r]+\r\n\r\n([\s\S]+?)\r\n--vitehub-/,
      )?.[1] ?? "";
    expect(encoded.split("\r\n").every((line) => line.length <= 76)).toBe(true);
    expect(encoded.replaceAll("\r\n", "")).toBe("A".repeat(160));
  });

  it("rejects overlong attachment MIME headers before sending", async () => {
    const send = vi.fn();
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() });

    await expect(
      driver.send(
        {
          ...message,
          attachments: [{ content: "report", filename: `${"x".repeat(980)}.txt` }],
        },
        context,
      ),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects header injection before sending", async () => {
    const send = vi.fn();
    // SAFETY: this mock constructor deliberately omits the runtime constructor signature.
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() as never });
    await expect(
      driver.send({ ...message, subject: "Hello\r\nBcc: attacker@example.com" }, context),
    ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { subject: "Hello\0world" },
    { headers: { "X-Trace-Id": "trace\u0001id" } },
    { from: { email: "hello@example.com", name: "Vite\u0007Hub" } },
    { attachments: [{ content: "report", filename: "report\u007F.txt" }] },
  ])("rejects control characters in raw MIME headers before sending", async (invalid) => {
    const send = vi.fn();
    // SAFETY: this mock constructor deliberately omits the runtime constructor signature.
    const driver = cloudflareEmail({ binding: { send }, EmailMessage: class {} as never });

    await expect(driver.send({ ...message, ...invalid }, context)).resolves.toMatchObject({
      error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["Content-Type", "mime-version", "From", "Subject", "Date"])(
    "rejects the transport-owned %s header",
    async (header) => {
      const send = vi.fn();
      // SAFETY: this mock constructor deliberately omits the runtime constructor signature.
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() as never });

      await expect(
        driver.send({ ...message, headers: { [header]: "custom" } }, context),
      ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["Content-Type: text/plain", "bad header", "X-Test("])(
    "rejects the invalid header name %s",
    async (header) => {
      const send = vi.fn();
      // SAFETY: this mock constructor deliberately omits the runtime constructor signature.
      const driver = cloudflareEmail({ binding: { send }, EmailMessage: vi.fn() as never });

      await expect(
        driver.send({ ...message, headers: { [header]: "value" } }, context),
      ).resolves.toMatchObject({ error: { code: "INVALID_OPTIONS", driver: "cloudflare-email" } });
      expect(send).not.toHaveBeenCalled();
    },
  );
});
