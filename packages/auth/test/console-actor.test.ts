import { admin } from "better-auth/plugins";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { createAccessControl } from "better-auth/plugins/access";
import type { SecondaryStorage } from "better-auth";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthConsole } from "../src/console-runtime.ts";
import { defineAuth } from "../src/index.ts";
import { createAuthForRequest } from "../src/server.ts";
import { consoleEventsFixture } from "./fixtures/console-events.ts";

const origin = "http://localhost:5173";
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function app(options?: Parameters<typeof consoleEventsFixture>[0]) {
  const fixture = await consoleEventsFixture(options);
  closers.push(() => fixture.database.sqlite.close());
  return fixture;
}

/** A signed Console call: no cookie, no bearer header. */
const signedCall = () => new Request(`${origin}/_vitehub/rpc`, { method: "POST", headers: { origin: "https://console.vitehub.dev" } });

describe("Auth changes for a signed Console person", () => {
  it("runs as the app user with the same email, with that user's live session, and records that actor", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store, { actor: { email: "Operator@Example.com" } });
    const [describeError, description] = await api.describe(signedCall());
    expect(describeError).toBeUndefined();
    expect(description?.actions.ban).toEqual({ enabled: true });
    const [error, response] = await api.execute({ action: "ban", userId: fixture.member.id, reason: "Console" }, signedCall());
    expect(error).toBeUndefined();
    expect(await response?.json()).toEqual({ action: "ban", actor: `user:${fixture.operator.id}`, ok: true, target: fixture.member.id });
    expect((await fixture.store.list({ type: "user.banned" })).events).toEqual([expect.objectContaining({ actor: `user:${fixture.operator.id}`, userId: fixture.member.id })]);
    // The acting session never reaches the caller.
    expect(response?.headers.get("set-cookie")).toBeNull();
  });

  it("refuses changes for a person without an app account, with the reason on every action", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store, { actor: { email: "stranger@example.com" } });
    const [, description] = await api.describe(signedCall());
    expect(description?.actions.ban).toEqual({ enabled: false, reason: expect.stringContaining("No app user has the email of your Console account, stranger@example.com") });
    const [error] = await api.execute({ action: "ban", userId: fixture.member.id }, signedCall());
    expect(error).toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
    expect(error?.cause).toMatchObject({ message: expect.stringContaining("No app user") });
  });

  it("refuses changes when the app account has no live session", async () => {
    const fixture = await app();
    fixture.database.sqlite.prepare("DELETE FROM session WHERE userId = ?").run(fixture.operator.id);
    const api = createAuthConsole(fixture.auth, {}, fixture.store, { actor: { email: "operator@example.com" } });
    const [error] = await api.execute({ action: "ban", userId: fixture.member.id }, signedCall());
    expect(error).toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
    expect(error?.cause).toMatchObject({ message: expect.stringContaining("Sign in to the app as operator@example.com") });
  });

  it("keeps Better Auth's permissions: a person whose app account is not an admin cannot ban", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store, { actor: { email: "ada@example.com" } });
    const [, description] = await api.describe(signedCall());
    expect(description?.actions.ban.enabled).toBe(false);
    const [error] = await api.execute({ action: "ban", userId: fixture.operator.id }, signedCall());
    expect(error).toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
    expect((await fixture.store.list({ type: "user.banned" })).events).toEqual([]);
  });

  it("finds the actor's session in secondaryStorage, where Better Auth keeps sessions by default", async () => {
    const cache = new Map<string, string>();
    const secondaryStorage: SecondaryStorage = {
      get: async (key) => cache.get(key) ?? null,
      set: async (key, value) => { cache.set(key, value); },
      delete: async (key) => { cache.delete(key); },
      getAndDelete: async (key) => {
        const value = cache.get(key) ?? null;
        cache.delete(key);
        return value;
      },
      increment: async (key) => {
        const value = Number(cache.get(key) ?? 0) + 1;
        cache.set(key, String(value));
        return value;
      },
    };
    const fixture = await app({ secondaryStorage });
    // The stored session keeps the user as it was at sign-in, so the operator signs in again after getting the admin role.
    expect((await fixture.request("sign-in/email", { email: "operator@example.com", password: "passwordpassword" })).status).toBe(200);
    expect([...cache.keys()].some((key) => key.startsWith("active-sessions-"))).toBe(true);
    const api = createAuthConsole(fixture.auth, {}, fixture.store, { actor: { email: "operator@example.com" } });
    const [describeError, description] = await api.describe(signedCall());
    expect(describeError).toBeUndefined();
    expect(description?.actions.ban, JSON.stringify(description?.actions.ban)).toEqual({ enabled: true });
    const [error, response] = await api.execute({ action: "ban", userId: fixture.member.id }, signedCall());
    expect(error?.cause ?? error).toBeUndefined();
    expect(await response?.json()).toMatchObject({ action: "ban", actor: `user:${fixture.operator.id}`, ok: true });
  });

  it("checks an impersonation target with the actor's session, as describe() does", async () => {
    const statements = { ...defaultStatements, user: [...defaultStatements.user, "impersonate-admins"] } as const;
    const ac = createAccessControl(statements);
    const superadmin = ac.newRole({ ...adminAc.statements, user: [...adminAc.statements.user, "impersonate-admins"] });
    const fixture = await app({ plugins: [admin({ ac, roles: { superadmin, user: ac.newRole({}) }, adminRoles: ["superadmin"] })], operatorRole: "superadmin" });
    fixture.database.sqlite.prepare("UPDATE user SET role = 'superadmin' WHERE id = ?").run(fixture.member.id);
    const api = createAuthConsole(fixture.auth, {}, fixture.store, { actor: { email: "operator@example.com" }, impersonation: true });
    const [, description] = await api.describe(signedCall());
    expect(description?.actions.impersonate).toEqual({ enabled: true });
    const [error, detail] = await api.user(fixture.member.id, signedCall());
    expect(error).toBeUndefined();
    expect(detail?.impersonation).toEqual({ enabled: true });
    // Without an app account for the person, the target check refuses an administrator.
    const stranger = createAuthConsole(fixture.auth, {}, fixture.store, { actor: { email: "stranger@example.com" }, impersonation: true });
    const [, refused] = await stranger.user(fixture.member.id, signedCall());
    expect(refused?.impersonation).toMatchObject({ enabled: false });
  });

  it("says why when the app keeps sessions only in cookies", async () => {
    const context = { adapter: {}, options: {}, internalAdapter: { listSessions: async () => [] } };
    // SAFETY: A Better Auth instance without a database: the Auth Console reads only these members before it refuses.
    const api = createAuthConsole({ api: {}, $context: Promise.resolve(context) } as unknown as Parameters<typeof createAuthConsole>[0], {}, undefined, { actor: { email: "operator@example.com" } });
    const [error] = await api.execute({ action: "ban", userId: "user-2" }, signedCall());
    expect(error).toMatchObject({ code: "AUTH_CONSOLE_UNAVAILABLE" });
    expect(error?.cause).toMatchObject({ message: expect.stringContaining("keeps sessions only in cookies") });
    const [, description] = await api.describe(signedCall());
    expect(description?.actions.ban).toMatchObject({ enabled: false });
  });

  it("never starts an impersonation from a signed call", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store, { actor: { email: "operator@example.com" }, impersonation: true });
    const [error] = await api.execute({ action: "impersonate", userId: fixture.member.id }, signedCall());
    expect(error?.cause).toMatchObject({ message: expect.stringContaining("browser's app session") });
    expect((await fixture.store.list({ type: "impersonation.started" })).events).toEqual([]);
  });
});

describe("one-time values and the app session", () => {
  it("keeps a value until one caller takes it, and drops it after its expiry", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store);
    expect(await api.saveVerification("ticket:a", "value-a", new Date(Date.now() + 60_000))).toEqual([undefined, undefined]);
    const taken = await Promise.all([api.consumeVerification("ticket:a"), api.consumeVerification("ticket:a")]);
    expect(taken.map(([, value]) => value)).toEqual(expect.arrayContaining(["value-a", null]));
    expect(taken.filter(([, value]) => value === "value-a")).toHaveLength(1);
    await api.saveVerification("ticket:b", "value-b", new Date(Date.now() - 1));
    expect(await api.consumeVerification("ticket:b")).toEqual([undefined, null]);
  });

  it("lists kept values by prefix and deletes them", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store);
    const later = new Date(Date.now() + 60_000);
    await api.saveVerification("invite:a", "value-a", later);
    await api.saveVerification("invite:old", "value-old", new Date(Date.now() - 1));
    await api.saveVerification("other:c", "value-c", later);
    const [, listed] = await api.listVerifications("invite:");
    expect(listed?.map((row) => [row.identifier, row.value])).toEqual([["invite:a", "value-a"]]);
    expect(await api.deleteVerification("invite:a")).toEqual([undefined, undefined]);
    expect((await api.listVerifications("invite:"))[1]).toEqual([]);
  });

  it("refuses one-time values on the memory database that Auth adds, in every request instance", async () => {
    const definition = defineAuth({ emailAndPassword: { enabled: true }, runtime: { secret: "console-actor-memory-secret-abcdefghijklmnopqrstuvwxyz", baseURL: origin } });
    const consoles = Array.from({ length: 8 }, () => createAuthConsole(createAuthForRequest(definition, new Request(origin))));
    const [saveError] = await consoles[0]!.saveVerification("ticket:memory", "value", new Date(Date.now() + 60_000));
    expect(saveError).toMatchObject({ code: "AUTH_CONSOLE_UNAVAILABLE" });
    const taken = await Promise.all(consoles.map((api) => api.consumeVerification("ticket:memory")));
    expect(taken.map(([error]) => error?.code)).toEqual(Array.from({ length: 8 }, () => "AUTH_CONSOLE_UNAVAILABLE"));
  });

  it("reads the app session of the request and who impersonates in it", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store);
    const request = (cookie: string) => new Request(`${origin}/_vitehub/rpc`, { headers: { cookie } });
    expect(await api.session(request(""))).toEqual([undefined, null]);
    expect(await api.session(request(fixture.operator.cookie))).toEqual([undefined, {
      user: { id: fixture.operator.id, email: "operator@example.com" },
      impersonatedBy: null,
    }]);
  });
});

describe("users and sessions that a host signs in", () => {
  const browser = (cookie = "") => new Request(`${origin}/_vitehub/rpc?ticket=t`, { headers: { cookie, "user-agent": "Mozilla/5.0 (iPhone) Safari/605.1.15" } });

  it("adds roles to the user with the email, and signs a browser in with a Better Auth session", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store);
    const [error, user] = await api.hostUser({ email: "Ada@Example.com", name: "Ada", roles: ["console", "comments-read"] });
    expect(error).toBeUndefined();
    expect(user).toEqual({ id: fixture.member.id, roles: ["user", "console", "comments-read"] });
    const [, headers] = await api.hostSession(fixture.member.id, browser());
    const cookie = headers!.get("set-cookie")!;
    expect(cookie).toMatch(/^better-auth\.session_token=[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
    const session = await fixture.auth.api.getSession({ headers: new Headers({ cookie: cookie.split(";")[0]! }) });
    expect(session?.user).toMatchObject({ id: fixture.member.id, role: "user,console,comments-read" });
  });

  it("creates a guest without an email, lists the sessions of role holders, and revokes and removes them", async () => {
    const fixture = await app();
    const api = createAuthConsole(fixture.auth, {}, fixture.store);
    const [, guest] = await api.hostUser({ name: "Ana", roles: ["guest", "comments-read", "comments-write"] });
    await api.hostSession(guest!.id, browser());
    const [, sessions] = await api.hostSessions(["guest", "console"]);
    expect(sessions).toEqual([expect.objectContaining({ user: expect.objectContaining({ id: guest!.id, name: "Ana", email: expect.stringMatching(/^guest-.+@guests\.invalid$/) }), roles: ["guest", "comments-read", "comments-write"], device: "Safari · iOS" })]);
    expect(await api.revokeHostSession(sessions![0]!.id)).toEqual([undefined, { userId: guest!.id, roles: ["guest", "comments-read", "comments-write"] }]);
    expect((await api.hostSessions(["guest"]))[1]).toEqual([]);
    expect((await api.revokeHostSession(sessions![0]!.id))[0]).toMatchObject({ code: "AUTH_CONSOLE_NOT_FOUND" });
    await api.removeHostUser(guest!.id);
    expect(fixture.database.sqlite.prepare("SELECT id FROM user WHERE id = ?").get(guest!.id)).toBeUndefined();
  });

  it.each(["member", "guest"])("revokes a %s browser by its public session ID in secondary storage", async (kind) => {
    const cache = new Map<string, string>();
    const fixture = await app({ secondaryStorage: {
      get: async (key) => cache.get(key) ?? null,
      set: async (key, value) => { cache.set(key, value); },
      delete: async (key) => { cache.delete(key); },
      getAndDelete: async (key) => {
        const value = cache.get(key) ?? null;
        cache.delete(key);
        return value;
      },
      increment: async (key) => {
        const value = Number(cache.get(key) ?? 0) + 1;
        cache.set(key, String(value));
        return value;
      },
    } });
    const api = createAuthConsole(fixture.auth, {}, fixture.store);
    const roles = kind === "member" ? ["console"] : ["guest", "comments-read"];
    const [userError, user] = await api.hostUser({
      ...(kind === "member" ? { email: "ada@example.com" } : {}),
      name: "Browser owner",
      roles,
    });
    expect(userError).toBeUndefined();
    const [sessionError, headers] = await api.hostSession(user!.id, browser());
    expect(sessionError).toBeUndefined();
    const cookie = headers!.get("set-cookie")!.split(";")[0]!;
    const session = () => fixture.auth.api.getSession({ headers: new Headers({ cookie }) });
    const signedIn = await session();
    expect(signedIn?.user.id).toBe(user!.id);
    const [listError, sessions] = await api.hostSessions(roles);
    expect(listError).toBeUndefined();
    const listed = sessions!.find((row) => row.id === signedIn!.session.id);
    expect(listed).toBeDefined();
    expect(listed).not.toHaveProperty("token");
    expect(await api.revokeHostSession(listed!.id)).toEqual([undefined, { userId: user!.id, roles: user!.roles }]);
    expect(await session()).toBeNull();
    expect((await api.hostSessions(roles))[1]?.some((row) => row.id === listed!.id)).toBe(false);
    expect((await api.revokeHostSession(listed!.id))[0]).toMatchObject({ code: "AUTH_CONSOLE_NOT_FOUND" });
  });

  it("needs admin(), which keeps the roles", async () => {
    const fixture = await app();
    const context = await fixture.auth.$context;
    const api = createAuthConsole({ api: fixture.auth.api, $context: Promise.resolve({ ...context, options: { ...context.options, plugins: [] } }) });
    const [error] = await api.hostUser({ name: "Ana", roles: ["guest"] });
    expect(error?.cause).toMatchObject({ message: expect.stringContaining("admin()") });
  });
});
