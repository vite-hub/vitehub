import { getMigrations } from "better-auth/db/migration";
import { admin, bearer } from "better-auth/plugins";
import { afterEach, describe, expect, it } from "vitest";
import { defineAuth } from "../src/index.ts";
import type { AuthDefinitionOptions } from "../src/types.ts";
import { createBetterAuthOptions, getAuthForDefinition } from "../src/server.ts";
import { eventDatabase } from "./event-helpers.ts";

const origin = "http://localhost:5173";
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** Merge the cookies that a response sets into a Cookie header, as a browser does. */
function jar(cookie: string, response: Response): string {
  const values = new Map(
    cookie
      .split("; ")
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair] as const),
  );
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0]!;
    const name = pair.slice(0, pair.indexOf("="));
    if (/max-age=0/i.test(header) || pair.endsWith("=")) values.delete(name);
    else values.set(name, pair);
  }
  return [...values.values()].join("; ");
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get: (key: string) => values.get(key) ?? null,
    getAndDelete: (key: string) => {
      const value = values.get(key) ?? null;
      values.delete(key);
      return value;
    },
    increment: (key: string) => {
      const value = Number(values.get(key) ?? 0) + 1;
      values.set(key, String(value));
      return value;
    },
    set: (key: string, value: string) => void values.set(key, value),
    delete: (key: string) => void values.delete(key),
  };
}

type Setup = Pick<AuthDefinitionOptions, "session" | "databaseHooks"> & { secondaryStorage?: boolean };

/** Starts an impersonation and returns the ways a client can send the impersonation session. */
async function impersonating(setup: Setup = {}) {
  const database = eventDatabase();
  closers.push(() => database.sqlite.close());
  const definition = defineAuth({
    emailAndPassword: { enabled: true },
    plugins: [admin(), bearer()],
    session: setup.session,
    databaseHooks: setup.databaseHooks,
    runtime: {
      database: database.sqlite,
      secondaryStorage: setup.secondaryStorage ? memoryStorage() : undefined,
      secret: "impersonation-refresh-paths-secret-abcdefghijklmnopqrstuvwxyz",
      baseURL: origin,
    },
  });
  await (await getMigrations(createBetterAuthOptions(definition))).runMigrations();
  const auth = getAuthForDefinition(definition);
  const request = (path: string, init: { method?: string; cookie?: string; authorization?: string; body?: object } = {}) =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: init.method ?? "GET",
        headers: {
          origin,
          cookie: init.cookie ?? "",
          ...(init.authorization ? { authorization: init.authorization } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      }),
    );
  const signUp = async (name: string) => {
    const response = await request("sign-up/email", {
      method: "POST",
      body: { name, email: `${name.toLowerCase()}@example.com`, password: "passwordpassword" },
    });
    const { user } = (await response.json()) as { user: { id: string } };
    return user.id;
  };
  const operatorId = await signUp("Operator");
  database.sqlite.prepare("UPDATE user SET role = 'admin' WHERE id = ?").run(operatorId);
  // A fresh sign-in, because a session in secondary storage keeps the user from before the role change.
  const operator = jar(
    "",
    await request("sign-in/email", { method: "POST", body: { email: "operator@example.com", password: "passwordpassword" } }),
  );
  const memberId = await signUp("Member");
  const started = await request("admin/impersonate-user", { method: "POST", cookie: operator, body: { userId: memberId } });
  expect(started.status).toBe(200);
  const browser = jar(operator, started);
  const tokenOnly = browser
    .split("; ")
    .filter((pair) => pair.startsWith("better-auth.session_token="))
    .join("; ");
  /** The stored expiry, read without a refresh. */
  const expiresAt = async () => {
    const current = await auth.api.getSession({
      headers: new Headers({ cookie: tokenOnly }),
      query: { disableCookieCache: true, disableRefresh: true },
    });
    expect(current?.user.id).toBe(memberId);
    return new Date(current!.session.expiresAt).getTime();
  };
  return { request, tokenOnly, bearer: `Bearer ${started.headers.get("set-auth-token")}`, expiresAt };
}

describe("impersonation expiry across Better Auth refresh paths", () => {
  it("keeps the expiry for a bearer client", async () => {
    const { request, bearer: authorization, expiresAt } = await impersonating();
    const before = await expiresAt();
    expect((await request("get-session", { authorization })).status).toBe(200);
    expect(await expiresAt()).toBe(before);
  });

  it("keeps the expiry when another endpoint resolves the session", async () => {
    const { request, tokenOnly, expiresAt } = await impersonating();
    const before = await expiresAt();
    expect((await request("list-sessions", { cookie: tokenOnly })).status).toBe(200);
    expect(await expiresAt()).toBe(before);
  });

  it("keeps the expiry for a deferred refresh", async () => {
    const { request, tokenOnly, expiresAt } = await impersonating({ session: { deferSessionRefresh: true } });
    const before = await expiresAt();
    expect((await request("get-session", { method: "POST", cookie: tokenOnly, body: {} })).status).toBe(200);
    expect(await expiresAt()).toBe(before);
  });

  it("keeps the expiry of a session in secondary storage", async () => {
    const { request, tokenOnly, expiresAt } = await impersonating({ secondaryStorage: true });
    const before = await expiresAt();
    expect((await request("get-session", { cookie: tokenOnly })).status).toBe(200);
    expect(await expiresAt()).toBe(before);
  });

  it("keeps the expiry when the app has a session update hook that returns the update", async () => {
    const { request, tokenOnly, expiresAt } = await impersonating({
      // The `{ data: { ...data } }` form that the Better Auth database hook docs show.
      databaseHooks: { session: { update: { before: async (data) => ({ data: { ...data } }) } } },
    });
    const before = await expiresAt();
    expect((await request("get-session", { cookie: tokenOnly })).status).toBe(200);
    expect(await expiresAt()).toBe(before);
  });
});
