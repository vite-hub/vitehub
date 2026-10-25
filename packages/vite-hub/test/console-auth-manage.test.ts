import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture } from "../../auth/test/fixtures/console.ts";
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
    for (const body of [{ operation: "users" }, { action: "ban", userId: "target" }])
      expect((await authManage(event(body))).status).toBe(403);
  });

  it("runs the real route with a Better Auth database, admin, and organization plugins", async () => {
    const { api, db: database, operator, member } = await fixture();
    state.inspect = api;
    installConsoleSections("auth-route-real", ["auth"]);
    installConsoleAccess({ mode: "open", authorize: () => ({ sections: ["auth"] }) });
    const request = (body: unknown) =>
      authManage(event(body, { cookie: operator.request.headers.get("cookie")! }));
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
