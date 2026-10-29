import { oauthProvider } from "@better-auth/oauth-provider";
import type { Result } from "@vite-hub/runtime";
import { getMigrations } from "better-auth/db/migration";
import { admin, emailOTP, jwt, phoneNumber, username } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthConsole } from "../src/console-runtime.ts";
import { createDatabaseAuthEventStore, defineAuth } from "../src/index.ts";
import { createBetterAuthOptions, getAuthForDefinition } from "../src/server.ts";
import { eventDatabase } from "./event-helpers.ts";

const origin = "http://localhost:5173";
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  vi.restoreAllMocks();
});

async function data<T>(operation: Promise<Result<T>>): Promise<T> {
  const [error, value] = await operation;
  if (error) throw error;
  return value;
}

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

/**
 * A local Better Auth app with the admin, OAuth Provider, and JWT plugins, plugins that change how a user signs in, and
 * a durable event log.
 */
async function app(options: { impersonationSessionDuration?: number } = {}) {
  const database = eventDatabase();
  closers.push(() => database.sqlite.close());
  const store = createDatabaseAuthEventStore({ db: database.db });
  const failing = { started: false };
  const definition = defineAuth({
    emailAndPassword: { enabled: true },
    plugins: [
      admin(options),
      jwt(),
      oauthProvider({ loginPage: "/login", consentPage: "/consent" }),
      emailOTP({ sendVerificationOTP: async () => {}, changeEmail: { enabled: true } }),
      phoneNumber({ sendOTP: async () => {} }),
      username(),
    ],
    events: {
      store: {
        ...store,
        async append(event) {
          if (failing.started && event.type === "impersonation.started")
            throw new Error("event store is down");
          await store.append(event);
        },
      },
    },
    runtime: {
      database: database.sqlite,
      secret: "console-impersonation-test-secret-abcdefghijklmnopqrstuvwxyz",
      baseURL: origin,
    },
  });
  await (await getMigrations(createBetterAuthOptions(definition))).runMigrations();
  const auth = getAuthForDefinition(definition);
  const request = (path: string, body: object, cookie = "") =>
    auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const signUp = async (name: string, role?: string) => {
    const response = await request("sign-up/email", {
      name,
      email: `${name.toLowerCase()}@example.com`,
      password: "passwordpassword",
    });
    expect(response.status).toBe(200);
    const { user } = (await response.json()) as { user: { id: string } };
    if (role) database.sqlite.prepare("UPDATE user SET role = ? WHERE id = ?").run(role, user.id);
    return { id: user.id, cookie: jar("", response) };
  };
  const operator = await signUp("Operator", "admin");
  const member = await signUp("Member");
  const consoleRequest = (cookie: string) =>
    new Request(`${origin}/_vitehub/auth/manage`, { method: "POST", headers: { cookie, origin } });
  const session = async (cookie: string) =>
    (await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
    })) as { user: { id: string }; session: { impersonatedBy?: string | null; expiresAt: Date } } | null;
  return {
    auth,
    store,
    database,
    failing,
    request,
    signUp,
    session,
    operator,
    member,
    consoleRequest,
    console: createAuthConsole(auth, {}, store, { impersonation: true }),
  };
}

describe("Console impersonation", () => {
  it("stays off, with no description, target check, or stop, unless the host enables it", async () => {
    const { auth, store, operator, member, consoleRequest } = await app();
    const off = createAuthConsole(auth, {}, store);
    const description = await data(off.describe(consoleRequest(operator.cookie)));
    expect(description.impersonation).toBeUndefined();
    expect(description.actions.impersonate).toEqual({
      enabled: false,
      reason: "Impersonation is off in the Console configuration.",
    });
    expect(await data(off.user(member.id, consoleRequest(operator.cookie)))).not.toHaveProperty(
      "impersonation",
    );
    await expect(
      data(off.execute({ action: "impersonate", userId: member.id }, consoleRequest(operator.cookie))),
    ).rejects.toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
    await expect(data(off.stopImpersonating(consoleRequest(operator.cookie)))).rejects.toMatchObject({
      code: "AUTH_CONSOLE_FORBIDDEN",
    });
    expect((await store.list({ type: "impersonation.started" })).events).toEqual([]);
  });

  it("rejects a user without the Better Auth impersonate permission", async () => {
    const { console, operator, member, consoleRequest } = await app();
    const request = consoleRequest(member.cookie);
    expect((await data(console.describe(request))).actions.impersonate).toEqual({
      enabled: false,
      reason: "Your app session does not have this Better Auth permission.",
    });
    await expect(
      data(console.execute({ action: "impersonate", userId: operator.id }, request)),
    ).rejects.toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
  });

  it("starts and stops impersonation, restores the admin session, and records both events", async () => {
    const { console, store, session, operator, member, consoleRequest } = await app();
    const before = await data(console.describe(consoleRequest(operator.cookie)));
    expect(before.actions.impersonate).toEqual({ enabled: true });
    expect(before.impersonation).toEqual({ duration: 3600, active: null });
    expect((await data(console.user(member.id, consoleRequest(operator.cookie)))).impersonation).toEqual({
      enabled: true,
    });

    const started = await data(
      console.execute({ action: "impersonate", userId: member.id }, consoleRequest(operator.cookie)),
    );
    expect(started.headers.get("cache-control")).toBe("no-store");
    const receipt = await started.clone().text();
    expect(JSON.parse(receipt)).toEqual({
      action: "impersonate",
      actor: `user:${operator.id}`,
      target: member.id,
      ok: true,
    });
    expect(receipt).not.toMatch(/token/i);
    const impersonating = jar(operator.cookie, started);
    const current = await session(impersonating);
    expect(current?.user.id).toBe(member.id);
    expect(current?.session.impersonatedBy).toBe(operator.id);
    expect(current!.session.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3600_000);

    const during = await data(console.describe(consoleRequest(impersonating)));
    expect(during.impersonation?.active).toMatchObject({ user: { id: member.id, name: "Member" } });
    expect(during.actions.impersonate).toEqual({
      enabled: false,
      reason: "This browser already impersonates a user. Stop impersonating first.",
    });

    const stopped = await data(console.stopImpersonating(consoleRequest(impersonating)));
    expect(await stopped.json()).toEqual({ action: "stopImpersonating", ok: true });
    const restored = jar(impersonating, stopped);
    expect((await session(restored))?.user.id).toBe(operator.id);
    expect((await session(restored))?.session.impersonatedBy ?? null).toBeNull();
    expect(await session(impersonating)).toBeNull();

    for (const type of ["impersonation.started", "impersonation.stopped"] as const)
      expect((await store.list({ type })).events, type).toEqual([
        expect.objectContaining({ actor: `user:${operator.id}`, userId: member.id }),
      ]);
  });

  it("reports Better Auth's target rules and refuses another administrator", async () => {
    const { console, database, signUp, operator, member, consoleRequest } = await app();
    const other = await signUp("Other", "admin");
    const request = consoleRequest(operator.cookie);
    expect((await data(console.user(other.id, request))).impersonation).toEqual({
      enabled: false,
      reason: "Better Auth does not impersonate administrators.",
    });
    await expect(
      data(console.execute({ action: "impersonate", userId: other.id }, request)),
    ).rejects.toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
    database.sqlite.prepare("UPDATE user SET banned = 1 WHERE id = ?").run(member.id);
    expect((await data(console.user(member.id, request))).impersonation).toEqual({
      enabled: false,
      reason: "Better Auth does not open sessions for banned users.",
    });
    const allowing = await app({ impersonationSessionDuration: 600 });
    expect((await data(allowing.console.describe(allowing.consoleRequest(allowing.operator.cookie)))).impersonation?.duration).toBe(600);
  });

  it("needs the event log, and does not start when the event log cannot record it", async () => {
    const { auth, console, database, failing, operator, member, consoleRequest, request } = await app();
    const unrecorded = createAuthConsole(auth, {}, undefined, { impersonation: true });
    expect((await data(unrecorded.describe(consoleRequest(operator.cookie)))).actions.impersonate).toEqual({
      enabled: false,
      reason: "Add events.store to defineAuth() so that impersonation is recorded.",
    });
    failing.started = true;
    vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});
    await expect(
      data(console.execute({ action: "impersonate", userId: member.id }, consoleRequest(operator.cookie))),
    ).rejects.toMatchObject({ code: "AUTH_CONSOLE_PROVIDER_FAILED" });
    const direct = await request("admin/impersonate-user", { userId: member.id }, operator.cookie);
    expect(direct.status).toBe(500);
    expect(direct.headers.getSetCookie().some((cookie) => cookie.includes("session_token=") && !/max-age=0/i.test(cookie))).toBe(false);
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM session WHERE impersonatedBy IS NOT NULL").get()).toEqual({ count: 0 });
  });

  it("keeps an impersonation session from extending itself or creating credentials", async () => {
    const { request, session, operator, member } = await app();
    const started = await request("admin/impersonate-user", { userId: member.id }, operator.cookie);
    expect(started.status).toBe(200);
    const impersonating = jar(operator.cookie, started);
    const expiresAt = (await session(impersonating))!.session.expiresAt.getTime();
    // Without `dont_remember`, Better Auth would refresh this one-hour session to the seven-day default.
    const tokenOnly = impersonating
      .split("; ")
      .filter((pair) => pair.startsWith("better-auth.session_token="))
      .join("; ");
    const refreshed = await session(tokenOnly);
    expect(refreshed?.user.id).toBe(member.id);
    expect(refreshed!.session.expiresAt.getTime()).toBe(expiresAt);

    for (const [path, body] of [
      ["admin/impersonate-user", { userId: operator.id }],
      ["oauth2/consent", { accept: true }],
      ["email-otp/request-email-change", { newEmail: "operator-inbox@example.com" }],
      ["phone-number/verify", { phoneNumber: "+15555550100", code: "123456", updatePhoneNumber: true }],
      ["update-user", { username: "operator_alias" }],
      ["update-user", { displayUsername: "operator_alias" }],
    ] as const) {
      const response = await request(path, body, impersonating);
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({ code: "IMPERSONATION_FORBIDDEN" });
    }
    // A profile change keeps the ways the user signs in.
    expect((await request("update-user", { name: "Member (fixed by support)" }, impersonating)).status).toBe(200);
    const own = await request("oauth2/consent", { accept: true }, operator.cookie);
    expect(own.status).not.toBe(403);
    expect((await request("update-user", { username: "operator_alias" }, operator.cookie)).status).toBe(200);
  });
});
