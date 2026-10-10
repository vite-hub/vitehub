import { afterEach, describe, expect, it, vi } from "vitest";

import { createConnectionsHandler } from "../src/http.ts";
import { checkConnectionsAccess } from "../src/internal/http-access.ts";
import { connectionsRoutes } from "../src/internal/http-routes.ts";
import { ACCESS_TOKEN, createTestRuntime, REFRESH_TOKEN } from "./helpers.ts";

import type { ConnectionsAccess } from "../src/internal/http-access.ts";
import type { ConnectionsRoute } from "../src/internal/http-routes.ts";

const origin = "http://localhost:5173";
const base = "/_vitehub/connections";

/** One request for each Connections route. A new route must add its request here. */
const routeRequests: Record<ConnectionsRoute["id"], () => Request> = {
  action: () => new Request(`${origin}${base}`, {
    body: JSON.stringify({ action: "list" }),
    headers: { "content-type": "application/json", origin },
    method: "POST",
  }),
  callback: () => new Request(`${origin}${base}/callback?state=state&code=code`, {
    headers: { cookie: "vitehub_connection_state=state" },
  }),
  connect: () => new Request(`${origin}${base}/connect/mail`),
};

function tokenResponse() {
  return { body: { access_token: ACCESS_TOKEN, expires_in: 3600, id_token: "account-1", refresh_token: REFRESH_TOKEN, scope: "mail.modify" } };
}

async function start(handler: (request: Request) => Promise<Response>): Promise<string> {
  const response = await handler(new Request(`${origin}${base}/connect/mail`));
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!).searchParams.get("state")!;
}

function callback(state: string): Request {
  return new Request(`${origin}${base}/callback?code=code-1&state=${state}`, {
    headers: { cookie: `vitehub_connection_state=${state}` },
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Connections route guard contract", () => {
  it("lists every Connections route", () => {
    expect(connectionsRoutes.map((route) => `${route.method} ${route.id}`).sort()).toEqual([
      "GET callback",
      "GET connect",
      "POST action",
    ]);
    for (const route of connectionsRoutes) {
      expect(route.matches(new URL(routeRequests[route.id]().url).pathname, base)).toBe(true);
    }
  });

  it.each(connectionsRoutes.map((route) => [route.id, route] as const))("runs the %s route only behind the access check", async (_id, route) => {
    const runtime = vi.fn(() => createTestRuntime().runtime);
    const handler = createConnectionsHandler({ actor: () => undefined, runtime });
    const response = await handler(routeRequests[route.id]());
    expect(response.status).toBe(403);
    expect(runtime).not.toHaveBeenCalled();
  });

  it.each(connectionsRoutes.map((route) => [route.id, route] as const))("rejects a forged access in the %s route body", async (_id, route) => {
    const runtime = vi.fn(() => createTestRuntime().runtime);
    const request = routeRequests[route.id]();
    const check = await checkConnectionsAccess(() => "user:owner", request, undefined, runtime);
    if (!check.access) throw new Error("Expected access.");
    expect(Object.isFrozen(check.access)).toBe(true);
    // A copy has the same shape and brand, but the check did not create it.
    const forged: ConnectionsAccess = { ...check.access };
    await expect(route.handle(forged, base)).rejects.toThrow("requires the access of a checked request");
    expect(runtime).not.toHaveBeenCalled();
  });

  it("fails closed when a JavaScript caller omits the access policy", async () => {
    const runtime = vi.fn(() => createTestRuntime().runtime);
    // @ts-expect-error JavaScript callers can omit the required policy.
    const handler = createConnectionsHandler({ runtime });
    for (const request of Object.values(routeRequests)) {
      const response = await handler(request());
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: { code: "CONNECTION_AUTH_REQUIRED" } });
    }
    expect(runtime).not.toHaveBeenCalled();
  });

  it.each(["production", "test", ""])("fails closed for the development policy when NODE_ENV is %j", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    const runtime = vi.fn(() => createTestRuntime().runtime);
    const handler = createConnectionsHandler({ actor: "development", runtime });
    for (const request of Object.values(routeRequests)) {
      const response = await handler(request());
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        error: { code: "CONNECTION_AUTH_REQUIRED", message: expect.stringContaining("outside local development") },
      });
    }
    expect(runtime).not.toHaveBeenCalled();
  });

  it("allows the development policy on a development server as user:local", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const test = createTestRuntime();
    const handler = createConnectionsHandler({ actor: "development", runtime: () => test.runtime });
    expect((await handler(routeRequests.action())).status).toBe(200);
    const state = await start(handler);
    test.provider.tokenResponses.push(tokenResponse());
    expect((await handler(callback(state))).status).toBe(200);
    const activity = await test.runtime.activity({ name: "mail" });
    expect(activity.find((entry) => entry.action === "replace")).toMatchObject({ actor: { id: "local", kind: "user" } });
  });

  it("does not start a flow for a cross-site request", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({ actor: () => "user:owner", runtime: () => test.runtime });
    const response = await handler(new Request(`${origin}${base}/connect/mail`, { headers: { "sec-fetch-site": "cross-site" } }));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("Connections OAuth state binding", () => {
  it("rejects a reused state", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({ actor: () => "user:owner", runtime: () => test.runtime });
    const state = await start(handler);
    test.provider.tokenResponses.push(tokenResponse());
    expect((await handler(callback(state))).status).toBe(200);
    const exchanges = test.provider.calls.length;

    test.provider.tokenResponses.push(tokenResponse());
    const reused = await handler(callback(state));
    expect(reused.status).toBe(400);
    expect(await reused.text()).toContain("unknown or expired");
    expect(test.provider.calls).toHaveLength(exchanges);
  });

  it("rejects a state that another manager started, and consumes it", async () => {
    const test = createTestRuntime();
    const owner = createConnectionsHandler({ actor: () => "user:owner", runtime: () => test.runtime });
    const other = createConnectionsHandler({ actor: () => "user:other", runtime: () => test.runtime });
    const state = await start(owner);
    test.provider.tokenResponses.push(tokenResponse());

    const foreign = await other(callback(state));
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).toContain("Another user started this authorization request");
    expect(test.provider.calls).toHaveLength(0);
    expect(await test.runtime.inspect("mail")).toMatchObject({ status: "disconnected" });

    // The rejected attempt consumed the state, so the owner must start again.
    expect((await owner(callback(state))).status).toBe(400);
  });

  it("rejects a foreign state in the JSON complete action", async () => {
    const test = createTestRuntime();
    const owner = createConnectionsHandler({ actor: () => "user:owner", runtime: () => test.runtime });
    const other = createConnectionsHandler({ actor: () => "user:other", runtime: () => test.runtime });
    const state = await start(owner);
    const response = await other(new Request(`${origin}${base}`, {
      body: JSON.stringify({ action: "complete", code: "code-1", state }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "CONNECTION_DENIED" } });
    expect(test.provider.calls).toHaveLength(0);
  });

  it("rejects a callback without the state cookie of the starting browser", async () => {
    const test = createTestRuntime();
    const handler = createConnectionsHandler({ actor: () => "user:owner", runtime: () => test.runtime });
    const state = await start(handler);
    const response = await handler(new Request(`${origin}${base}/callback?code=code-1&state=${state}`, {
      headers: { cookie: "vitehub_connection_state=other" },
    }));
    expect(response.status).toBe(400);
    expect(test.provider.calls).toHaveLength(0);
  });

  it("binds runtime completion to the actor that started the flow", async () => {
    const test = createTestRuntime();
    const { state } = await test.runtime.authorize({ actor: "user:owner", name: "mail", redirectUri: "http://127.0.0.1:8976/callback" });
    await expect(test.runtime.complete({ actor: "user:other", code: "code-1", state })).rejects.toMatchObject({ code: "CONNECTION_DENIED" });
    await expect(test.runtime.complete({ actor: "user:owner", code: "code-1", state })).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
  });
});
