import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../../auth/test/fixtures/console.ts";
import { consoleEventsFixture } from "../../auth/test/fixtures/console-events.ts";
import authManage from "../src/console/runtime/server/auth-manage.ts";
import { installConsoleAccess } from "../src/console/runtime/server/access.ts";
import { installConsoleSections } from "../src/console/runtime/server/sections.ts";

const state = vi.hoisted(() => ({ inspect: undefined as unknown }));
vi.mock("@vite-hub/auth/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vite-hub/auth/server")>()),
  getAuthConsoleForRequest: () => state.inspect,
}));
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("vitehub.console.access"));
  state.inspect = undefined;
});

function event(body: unknown, headers: Record<string, string> = {}) {
  return {
    req: new Request("http://localhost:3000/_vitehub/auth/manage", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-vitehub-console": "1",
        origin: "http://localhost:3000",
        ...headers,
      },
    }),
  };
}

describe("Auth Console route", () => {
  it("rejects read and write access outside the auth section before opening Better Auth", async () => {
    installConsoleSections("auth-route-denied", ["auth"]);
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv"] }) });
    for (const body of [
      { operation: "users" },
      { operation: "overview" },
      { operation: "activity" },
      { action: "ban", userId: "target" },
    ])
      expect((await authManage(event(body))).status).toBe(403);
  });

  it("returns real recorded events through the guarded Overview and Activity routes", async () => {
    const app = await consoleEventsFixture();
    try {
      state.inspect = app.api;
      installConsoleSections("auth-route-events", ["auth"]);
      installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["auth"] }) });
      const call = (body: unknown) => authManage(event(body, { cookie: app.operator.cookie }));
      expect(
        (
          await app.request("sign-in/email", {
            email: "ada@example.com",
            password: "passwordpassword",
          })
        ).status,
      ).toBe(200);
      expect(
        (await call({ action: "ban", userId: app.member.id, reason: "private-ban-reason" })).status,
      ).toBe(200);
      const overview = await call({ operation: "overview" });
      expect(overview.headers.get("cache-control")).toBe("no-store");
      expect(await overview.json()).toMatchObject({
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
      const activity = await call({
        operation: "activity",
        activity: { group: "admin", userId: app.member.id },
      });
      expect(await activity.json()).toMatchObject({
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
        expect((await call({ operation: "activity", activity })).status).toBe(400);
      installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["kv"] }) });
      for (const operation of ["overview", "activity"])
        expect((await call({ operation })).status).toBe(403);
    } finally {
      app.database.sqlite.close();
    }
  });

  it("runs the real route with a Better Auth database, admin, and organization plugins", async () => {
    const { api, db: database, operator, member } = await fixture();
    state.inspect = api;
    installConsoleSections("auth-route-real", ["auth"]);
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["auth"] }) });
    const request = (body: unknown) =>
      authManage(event(body, { cookie: operator.request.headers.get("cookie")! }));
    const proxied = await authManage(
      event(
        { operation: "users" },
        {
          origin: "https://localhost:3000",
          "sec-fetch-site": "same-origin",
        },
      ),
    );
    expect(proxied.status).toBe(200);
    expect(await proxied.json()).toMatchObject({ total: 2 });
    const rejectedHeaders: Record<string, string>[] = [
      { origin: "null", "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { "sec-fetch-site": "same-origin", "x-vitehub-console": "" },
    ];
    for (const headers of rejectedHeaders) {
      await expect(authManage(event({ operation: "users" }, headers))).rejects.toMatchObject({
        statusCode: 403,
      });
    }
    const listed = await request({ operation: "users" });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ total: 2 });
    expect(
      (await request({ action: "editField", userId: member.id, field: "plan", value: "pro" }))
        .status,
    ).toBe(200);
    expect(database.user.find((user) => user.id === member.id)?.plan).toBe("pro");
    const sessionId = database.session.find((session) => session.userId === member.id)!.id;
    expect((await request({ action: "revokeSession", id: sessionId })).status).toBe(200);
    expect(database.session.some((session) => session.id === sessionId)).toBe(false);
    expect(
      (await request({ action: "ban", userId: member.id, reason: "Route fixture" })).status,
    ).toBe(200);
    expect(database.user.find((user) => user.id === member.id)?.banned).toBe(true);
    await expect(
      authManage(event({ operation: "users" }, { origin: "https://outside.example" })),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      authManage(event({ operation: "users" }, { "x-vitehub-console": "" })),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
