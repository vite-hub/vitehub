import { describe, expect, it, vi } from "vitest";

import { createConnectionsRuntime } from "../src/runtime.ts";
import { createConnectionsHandler } from "../src/http.ts";
import { ACCESS_TOKEN, createTestRuntime, REFRESH_TOKEN, mailConnection } from "./helpers.ts";

const origin = "http://localhost:5173";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/_vitehub/connections`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, ...headers },
    method: "POST",
  });
}

function streamedPost(body: ReadableStream<Uint8Array>): Request {
  const init: RequestInit & { duplex: "half" } = {
    body,
    headers: { "content-type": "application/json", origin },
    method: "POST",
    duplex: "half",
  };
  return new Request(`${origin}/_vitehub/connections`, init);
}

describe("createConnectionsHandler", () => {
  it.each([
    undefined,
    () => undefined,
    () => "agent:worker",
    () => "user:",
    () => "user:bad identity",
  ])("denies every route without a valid authenticated management user (%s)", async (actor) => {
    const getRuntime = vi.fn(() => createTestRuntime().runtime);
    const handler = createConnectionsHandler({ actor, runtime: getRuntime });
    for (const request of [
      post({ action: "list" }),
      post({ action: "revoke", name: "mail" }),
      post({ action: "approve", id: "approval_1" }),
      new Request(`${origin}/_vitehub/connections/connect/mail`),
      new Request(`${origin}/_vitehub/connections/callback?state=state&code=code`, {
        headers: { cookie: "vitehub_connection_state=state" },
      }),
    ]) {
      expect((await handler(request)).status).toBe(403);
    }
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it.each(["team/mail", "n".repeat(129), "sales+ops", "team/客户 inbox", ["a".repeat(166), "b".repeat(166), "c".repeat(167)].join("/")])("manages discovered names through JSON and web authorization (%s)", async (name) => {
    const test = createTestRuntime();
    const runtime = createConnectionsRuntime({
      definitions: { [name]: mailConnection() },
      fetch: test.provider.fetch,
      store: test.store,
    });
    const handler = createConnectionsHandler({ actor: () => "user:owner", runtime: () => runtime });
    const inspect = await handler(post({ action: "inspect", name }));
    expect(inspect.status).toBe(200);
    expect(await inspect.json()).toMatchObject({ connection: { name } });
    const start = await handler(new Request(`${origin}/_vitehub/connections/connect/${encodeURIComponent(name)}`));
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get("location")!).searchParams.get("state")).toBeTruthy();
    expect((await handler(post({ action: "inspect", name: "team//mail" }))).status).toBe(400);
  });

  it("runs JSON actions for same-origin requests", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({
      actor: () => "user:local",
      runtime: () => test.runtime,
    });
    const response = await handler(post({ action: "list" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connections: [{ name: "mail", provider: "example", status: "disconnected" }],
    });
  });

  it("stops and cancels oversized authenticated request streams", async () => {
    const runtime = vi.fn(() => createTestRuntime().runtime);
    const handler = createConnectionsHandler({ actor: () => "user:local", runtime });
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads > 20) controller.close();
        else controller.enqueue(new Uint8Array(8192).fill(120));
      },
      cancel,
    }, { highWaterMark: 0 });
    const response = await handler(streamedPost(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "CONNECTION_INVALID" } });
    expect(reads).toBe(9);
    expect(cancel).toHaveBeenCalledOnce();
    expect(runtime).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it.each([65536, 65537])("counts raw UTF-8 bytes for a %s-byte streamed body", async (size) => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => test.runtime });
    const encoder = new TextEncoder();
    const paddingSize = size - encoder.encode(JSON.stringify({ action: "list", padding: "" })).byteLength;
    const encoded = encoder.encode(JSON.stringify({ action: "list", padding: "é".repeat(Math.floor(paddingSize / 2)) + "a".repeat(paddingSize % 2) }));
    expect(encoded.byteLength).toBe(size);
    let offset = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === encoded.byteLength) controller.close();
        else {
          controller.enqueue(encoded.slice(offset, offset + 4095));
          offset = Math.min(offset + 4095, encoded.byteLength);
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    const response = await handler(streamedPost(body));
    expect(response.status).toBe(size === 65536 ? 200 : 400);
    expect(cancel).toHaveBeenCalledTimes(size === 65536 ? 0 : 1);
  });

  it("preserves streamed-body parse and read failures", async () => {
    const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => createTestRuntime().runtime });
    for (const [body, status] of [
      [new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{broken")); controller.close(); } }), 400],
      [new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("Stream failed")); } }), 500],
    ] as const) {
      const response = await handler(streamedPost(body));
      expect(response.status).toBe(status);
      expect(body.locked).toBe(false);
    }
  });

  it("dispatches and completes OAuth under an application base", async () => {
    const test = createTestRuntime()
    const handler = createConnectionsHandler({ actor: () => "user:local", basePath: "/portal/_vitehub/connections", runtime: () => test.runtime })
    const response = await handler(new Request(`${origin}/portal/_vitehub/connections`, {
      body: JSON.stringify({ action: "list" }), headers: { "content-type": "application/json", origin }, method: "POST",
    }))
    expect(response.status).toBe(200)
    const start = await handler(new Request(`${origin}/portal/_vitehub/connections/connect/mail`))
    expect(start.status).toBe(302)
    const location = new URL(start.headers.get("location")!)
    expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/portal/_vitehub/connections/callback`)
    expect(start.headers.get("set-cookie")).toContain("Path=/portal/_vitehub/connections;")
    const state = location.searchParams.get("state")!
    test.provider.tokenResponses.push({ body: { access_token: ACCESS_TOKEN, id_token: "account-1", refresh_token: REFRESH_TOKEN } })
    const callback = await handler(new Request(`${origin}/portal/_vitehub/connections/callback?code=code-1&state=${state}`, {
      headers: { cookie: `vitehub_connection_state=${state}` },
    }))
    expect(callback.status).toBe(200)
    expect(callback.headers.get("set-cookie")).toContain("Path=/portal/_vitehub/connections;")
  })

  it("pages pending approvals above the history limit", async () => {
    const test = createTestRuntime()
    for (let index = 0; index < 101; index++) {
      await test.store.approvals.create({ action: "mail.messages.modify", actor: "agent:mail", createdAt: new Date().toISOString(), id: `approval-${index}`, input: {}, name: "mail", status: "pending" })
    }
    const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => test.runtime })
    const response = await handler(post({ action: "approvals", name: "mail", status: "pending" }))
    // SAFETY: The local handler serializes the approval list from the real test store.
    const result = await response.json() as { approvals: Array<{ id: string }>, nextCursor: string }
    expect(result.approvals).toHaveLength(100)
    expect(result.nextCursor).toBe("approval-1")
    const older = await handler(post({ action: "approvals", before: result.nextCursor, name: "mail", status: "pending" }))
    expect(older.status).toBe(200)
    expect(await older.json()).toMatchObject({ approvals: [{ id: "approval-0" }] })
    const denied = await handler(post({ action: "deny", id: "approval-0" }))
    expect(denied.status).toBe(200)
    expect(await test.store.approvals.get("approval-0")).toMatchObject({ status: "denied" })
    expect((await test.runtime.approvals({})).approvals).toHaveLength(100)
  })

  it("serves Console approval summaries and counts", async () => {
    const test = createTestRuntime()
    await test.store.approvals.create({ action: "mail.messages.modify", actor: "agent:test", createdAt: new Date().toISOString(), id: "summary-1", input: { to: "ada@example.com" }, name: "mail", status: "pending" })
    const handler = createConnectionsHandler({ actor: () => "user:local", runtime: () => test.runtime })
    const page = await handler(post({ action: "approval-summaries", name: "mail", status: "pending" }))
    expect(await page.json()).toEqual({ approvals: [{ action: "mail.messages.modify", actor: "agent:test", createdAt: expect.any(String), id: "summary-1", name: "mail", status: "pending" }] })
    const counts = await handler(post({ action: "approval-counts" }))
    expect(await counts.json()).toEqual({ counts: { mail: 1 } })
  })

  it("rejects cross-origin, non-JSON, and invalid requests", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({
      actor: () => "user:local",
      runtime: () => test.runtime,
    });
    expect((await handler(post({ action: "inspect", name: "n".repeat(502) }))).status).toBe(400);
    expect(
      (await handler(post({ action: "list" }, { origin: "https://attacker.example.com" }))).status,
    ).toBe(403);
    expect(
      (await handler(post({ action: "list" }, { "sec-fetch-site": "cross-site" }))).status,
    ).toBe(403);
    expect((await handler(post({ action: "list" }, { "content-type": "text/plain" }))).status).toBe(
      403,
    );
    expect((await handler(post({ action: "drop" }))).status).toBe(400);
    expect((await handler(new Request(`${origin}/_vitehub/connections`))).status).toBe(405);
  });

  it("maps Connection errors to HTTP statuses", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({
      actor: () => "user:local",
      runtime: () => test.runtime,
    });
    const response = await handler(post({ action: "inspect", name: "missing" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "CONNECTION_INVALID" } });
    expect((await handler(post({ action: "approve", id: "approval_missing" }))).status).toBe(400);
  });

  it("completes the web authorization flow with a state cookie", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({
      actor: () => "user:owner",
      runtime: () => test.runtime,
    });
    const start = await handler(new Request(`${origin}/_vitehub/connections/connect/mail`));
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${origin}/_vitehub/connections/callback`,
    );
    const state = location.searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!;
    expect(cookie).toContain(`vitehub_connection_state=${state}`);
    expect(cookie).toContain("HttpOnly");

    const mismatch = await handler(
      new Request(`${origin}/_vitehub/connections/callback?code=code-1&state=${state}`),
    );
    expect(mismatch.status).toBe(400);

    test.provider.tokenResponses.push({
      body: {
        access_token: ACCESS_TOKEN,
        expires_in: 3600,
        id_token: "account-1",
        refresh_token: REFRESH_TOKEN,
        scope: "mail.modify",
      },
    });
    const callback = await handler(
      new Request(`${origin}/_vitehub/connections/callback?code=code-1&state=${state}`, {
        headers: { cookie: `vitehub_connection_state=${state}` },
      }),
    );
    expect(callback.status).toBe(200);
    const html = await callback.text();
    expect(html).toContain("owner@example.com");
    expect(html).not.toContain(ACCESS_TOKEN);
    expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "connected" });
    const activity = await test.runtime.activity({ name: "mail" });
    expect(activity.find((entry) => entry.action === "replace")).toMatchObject({
      actor: { id: "owner", kind: "user" },
    });
  });
});
