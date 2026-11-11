import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../../auth/test/fixtures/console.ts";
import { consoleEventsFixture } from "../../auth/test/fixtures/console-events.ts";
import { authConsoleActionOperations, authConsoleReadOperations } from "../src/console/runtime/auth-operations.ts";
import { installConsoleAccess } from "../src/console/runtime/server/access.ts";
import { installConsoleSections } from "../src/console/runtime/server/sections.ts";
import { changeAuthConsole, readAuthConsole } from "../src/console/runtime/client/auth-management.ts";
import { handleConsoleRpcRequest } from "./support/console-rpc.ts";
import { operationRpcBody, operationRpcFetch, operationRpcRequest, operationRpcResponseResult } from "../../internal/test-utils/operation-rpc.ts"

const state = vi.hoisted(() => ({ inspect: undefined as unknown }));
vi.mock("@vite-hub/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vite-hub/auth/server")>()),
  getAuthConsoleForRequest: () => state.inspect,
}));
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"));
  state.inspect = undefined;
  vi.unstubAllGlobals();
});

const headers = {
  "content-type": "application/json",
  "x-vitehub-console": "1",
  origin: "http://localhost:3000",
};

/** One Auth Console call as its `auth.*` operation, in the old `{ operation }` or `{ action }` command shape. */
async function call(command: Record<string, unknown>, extra: Record<string, string> = {}): Promise<Response> {
  const { action, activity, operation, query, ...fields } = command;
  const name = typeof operation === "string"
    ? authConsoleReadOperations[operation as keyof typeof authConsoleReadOperations]
    : authConsoleActionOperations[action as keyof typeof authConsoleActionOperations];
  const input = { ...fields, ...Object(query), ...Object(activity) };
  return await handleConsoleRpcRequest(new Request("http://localhost:3000/_vitehub/rpc", {
    method: "POST",
    body: operationRpcBody(name, input),
    headers: { ...headers, ...extra },
  }));
}

/** The value of a successful operation call. */
async function value(response: Promise<Response>): Promise<unknown> {
  const body: unknown = await operationRpcResponseResult(await response);
  expect(body).toMatchObject({ ok: true });
  return Reflect.get(Object(body), "value");
}

describe("Auth Console operations", () => {
  it("rejects read and write access outside the auth section before opening Better Auth", async () => {
    installConsoleSections("auth-route-denied", ["auth"]);
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv"] }) });
    for (const body of [
      { operation: "users" },
      { operation: "overview" },
      { operation: "activity" },
      { action: "ban", userId: "target" },
    ])
      expect((await call(body)).status).toBe(403);
  });

  it("returns real recorded events through the guarded Overview and Activity operations", async () => {
    const app = await consoleEventsFixture();
    try {
      state.inspect = app.api;
      installConsoleSections("auth-route-events", ["auth"]);
      installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["auth"] }) });
      const signedIn = (body: Record<string, unknown>) => call(body, { cookie: app.operator.cookie });
      expect(
        (
          await app.request("sign-in/email", {
            email: "ada@example.com",
            password: "passwordpassword",
          })
        ).status,
      ).toBe(200);
      expect(
        (await signedIn({ action: "ban", userId: app.member.id, reason: "private-ban-reason" })).status,
      ).toBe(200);
      const overview = await signedIn({ operation: "overview" });
      expect(overview.headers.get("cache-control")).toBe("no-store");
      expect(await value(Promise.resolve(overview))).toMatchObject({
        users: 2,
        activeUsers: 2,
        analytics: { totals: { signUps: 2, signIns: 3 } },
        recent: {
          events: expect.arrayContaining([
            expect.objectContaining({ type: "user.signed_up" }),
            expect.objectContaining({ type: "user.signed_in" }),
            expect.objectContaining({ type: "user.banned" }),
          ]),
        },
      });
      expect(await value(signedIn({
        operation: "activity",
        activity: { group: "admin", userId: app.member.id },
      }))).toMatchObject({
        enabled: true,
        events: expect.arrayContaining([
          expect.objectContaining({
            type: "user.banned",
            actor: { id: app.operator.id, name: "Operator", available: true },
            subject: { id: app.member.id, name: "Ada Lovelace", available: true },
          }),
        ]),
      });
      for (const activity of [{ group: "unknown" }, { cursor: "%" }, { limit: 201 }])
        expect((await signedIn({ operation: "activity", activity })).status).toBe(400);
      installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv"] }) });
      for (const operation of ["overview", "activity"])
        expect((await signedIn({ operation })).status).toBe(403);
    } finally {
      app.database.sqlite.close();
    }
  });

  it("runs the real operations with a Better Auth database, admin, and organization plugins", async () => {
    const { api, db: database, operator, member } = await fixture();
    state.inspect = api;
    installConsoleSections("auth-route-real", ["auth"]);
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["auth"] }) });
    const request = (body: Record<string, unknown>) => call(body, { cookie: operator.request.headers.get("cookie")! });
    expect(await value(call({ operation: "users" }, { origin: "https://localhost:3000", "sec-fetch-site": "same-origin" }))).toMatchObject({ total: 2 });
    for (const rejected of [
      { origin: "null", "sec-fetch-site": "same-origin" } as Record<string, string>,
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://outside.example" },
    ]) {
      await expect(call({ operation: "users" }, rejected)).resolves.toMatchObject({ status: 403 });
    }
    expect(await value(request({ operation: "users" }))).toMatchObject({ total: 2 });
    expect(await value(request({ action: "editField", userId: member.id, field: "plan", value: "pro" }))).toMatchObject({ action: "editField", ok: true });
    expect(database.user.find((user) => user.id === member.id)?.plan).toBe("pro");
    const sessionId = database.session.find((session) => session.userId === member.id)!.id;
    expect((await request({ action: "revokeSession", id: sessionId })).status).toBe(200);
    expect(database.session.some((session) => session.id === sessionId)).toBe(false);
    expect((await request({ action: "ban", userId: member.id, reason: "Route fixture" })).status).toBe(200);
    expect(database.user.find((user) => user.id === member.id)?.banned).toBe(true);
  });

});

describe("Auth Console client", () => {
  it("reads and changes Auth through operations, and opens impersonation links in a new tab", async () => {
    const sent: Array<{ body: unknown; path: string }> = [];
    vi.stubGlobal("fetch", operationRpcFetch(async (input: string, init?: RequestInit) => {
      const body = operationRpcRequest(init?.body);
      sent.push({ body, path: input });
      const operation = Reflect.get(Object(body), "operation");
      return Response.json({ ok: true, value: operation === "auth.impersonate" || operation === "auth.stop-impersonating" ? { url: `https://app.example.com/_vitehub/rpc?ticket=${operation}`, expiresAt: "2026-11-11T00:01:00.000Z" } : { total: 0 } });
    }));
    const opened: string[] = [];
    const tab = { opener: {} as unknown, location: { replace: (url: string) => opened.push(url) }, close: vi.fn() };
    vi.stubGlobal("open", vi.fn(() => tab));
    await readAuthConsole("users", { query: { limit: 25, search: "ada" } });
    await readAuthConsole("organization", { id: "org", query: { offset: 25 } });
    await changeAuthConsole({ action: "revokeSessions", userId: "u1" });
    await changeAuthConsole({ action: "impersonate", userId: "u1" });
    await changeAuthConsole({ action: "stopImpersonating" });
    expect(sent).toEqual([
      { body: { input: { limit: 25, search: "ada" }, operation: "auth.users" }, path: "/_vitehub/rpc" },
      { body: { input: { id: "org", offset: 25 }, operation: "auth.organization" }, path: "/_vitehub/rpc" },
      { body: { input: { userId: "u1" }, operation: "auth.revoke-sessions" }, path: "/_vitehub/rpc" },
      { body: { input: { userId: "u1" }, operation: "auth.impersonate" }, path: "/_vitehub/rpc" },
      { body: { input: {}, operation: "auth.stop-impersonating" }, path: "/_vitehub/rpc" },
    ]);
    // The tab opens before the call and cannot reach the Console page.
    expect(opened).toEqual(["https://app.example.com/_vitehub/rpc?ticket=auth.impersonate", "https://app.example.com/_vitehub/rpc?ticket=auth.stop-impersonating"]);
    expect(tab.opener).toBeNull();
    expect(tab.close).not.toHaveBeenCalled();
  });

  it("closes the new tab when the app refuses the link", async () => {
    vi.stubGlobal("fetch", operationRpcFetch(async () => Response.json({ ok: false, code: "CONSOLE_ACCESS_DENIED", message: "No.", status: 403 }, { status: 403 })));
    const tab = { opener: {} as unknown, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal("open", vi.fn(() => tab));
    await expect(changeAuthConsole({ action: "impersonate", userId: "u1" })).rejects.toThrow();
    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });
});
