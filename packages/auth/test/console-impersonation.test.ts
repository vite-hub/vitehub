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
      socialProviders: {
        google: {
          clientId: "google-client",
          clientSecret: "google-secret",
          refreshAccessToken: async () => ({
            accessToken: "refreshed-provider-access",
            refreshToken: "rotated-provider-refresh",
            accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
          }),
        },
      },
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

  it("blocks linked-account token retrieval and unlinking while keeping account metadata readable", async () => {
    const { auth, request, operator, member } = await app();
    const context = await auth.$context;
    const account = await context.internalAdapter.createAccount({
      userId: member.id,
      providerId: "google",
      accountId: "member-google",
      accessToken: "provider-access",
      refreshToken: "provider-refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scope: "profile",
    });

    const started = await request("admin/impersonate-user", { userId: member.id }, operator.cookie);
    expect(started.status).toBe(200);
    const impersonating = jar(operator.cookie, started);
    const responses = new Map<string, Response>();
    for (const path of ["get-access-token", "refresh-token", "unlink-account"]) {
      responses.set(path, await request(path, { accountId: account.id }, impersonating));
    }
    expect([...responses].map(([path, response]) => [path, response.status])).toEqual([
      ["get-access-token", 403],
      ["refresh-token", 403],
      ["unlink-account", 403],
    ]);
    for (const [path, response] of responses) {
      expect(await response.json(), path).toMatchObject({ code: "IMPERSONATION_FORBIDDEN" });
    }

    const accounts = await auth.handler(new Request(`${origin}/api/auth/list-accounts`, {
      headers: { cookie: impersonating },
    }));
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toContainEqual(expect.objectContaining({ id: account.id, providerId: "google" }));
    expect((await context.internalAdapter.findAccounts(member.id)).find(value => value.id === account.id)).toMatchObject({
      accessToken: "provider-access",
      refreshToken: "provider-refresh",
    });

    // The account owner can still use the provider tokens and remove their own linked account.
    const access = await request("get-access-token", { accountId: account.id }, member.cookie);
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({ accessToken: "provider-access" });
    const refreshed = await request("refresh-token", { accountId: account.id }, member.cookie);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ accessToken: "refreshed-provider-access", refreshToken: "rotated-provider-refresh" });
    expect((await request("unlink-account", { accountId: account.id }, member.cookie)).status).toBe(200);
    expect((await context.internalAdapter.findAccounts(member.id)).some(value => value.id === account.id)).toBe(false);
  });

  it.each([-60_000, 2_000])("blocks account-info token rotation with %i ms until expiry", async (expiresIn) => {
    const { auth, request, operator, member } = await app();
    const context = await auth.$context;
    const account = await context.internalAdapter.createAccount({
      userId: member.id,
      providerId: "google",
      accountId: "member-google",
      accessToken: "provider-access",
      refreshToken: "provider-refresh",
      accessTokenExpiresAt: new Date(Date.now() + expiresIn),
    });
    const before = (await context.internalAdapter.findAccounts(member.id)).find(value => value.id === account.id);
    const provider = context.socialProviders.find(value => value.id === "google")!;
    const refresh = vi.spyOn(provider, "refreshAccessToken");
    const update = vi.spyOn(context.internalAdapter, "updateAccount");
    const userInfo = vi.spyOn(provider, "getUserInfo").mockResolvedValue({
      user: { name: "Member", email: "member@example.com", emailVerified: true },
      data: { sub: "member-google" },
    });
    const started = await request("admin/impersonate-user", { userId: member.id }, operator.cookie);
    expect(started.status).toBe(200);
    const impersonating = jar(operator.cookie, started);
    const accountInfo = (cookie: string) => auth.handler(new Request(`${origin}/api/auth/account-info?accountId=${account.id}`, {
      headers: { cookie },
    }));

    const blocked = await accountInfo(impersonating);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "IMPERSONATION_FORBIDDEN" });
    expect(refresh).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(userInfo).not.toHaveBeenCalled();
    expect((await context.internalAdapter.findAccounts(member.id)).find(value => value.id === account.id)).toEqual(before);

    // The account owner's read can still refresh an expired or near-expiry token.
    const own = await accountInfo(member.cookie);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ account: { id: account.id }, user: { email: "member@example.com" } });
    expect(refresh).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith(account.id, expect.objectContaining({
      accessToken: "refreshed-provider-access",
      refreshToken: "rotated-provider-refresh",
    }));
    expect(userInfo).toHaveBeenCalledOnce();
    expect((await context.internalAdapter.findAccounts(member.id)).find(value => value.id === account.id)).toMatchObject({
      accessToken: "refreshed-provider-access",
      refreshToken: "rotated-provider-refresh",
    });
  });

  it("blocks server-only password creation for an impersonated OAuth-only user", async () => {
    const { auth, request, operator, member } = await app();
    const context = await auth.$context;
    await context.internalAdapter.createAccount({ userId: member.id, providerId: "google", accountId: "member-google" });
    const credential = await context.internalAdapter.findCredentialAccount(member.id);
    await context.internalAdapter.deleteAccount(credential!.id);
    const started = await request("admin/impersonate-user", { userId: member.id }, operator.cookie);
    expect(started.status).toBe(200);
    const impersonating = jar(operator.cookie, started);
    const newPassword = "permanent-password-for-member";

    // Server actions forward session headers to this API; it has no HTTP route in Better Auth 1.7.7.
    await expect(auth.api.setPassword({
      headers: new Headers({ cookie: impersonating, origin }),
      body: { newPassword },
    })).rejects.toMatchObject({ statusCode: 403, body: { code: "IMPERSONATION_FORBIDDEN" } });
    expect(await context.internalAdapter.findCredentialAccount(member.id)).toBeNull();

    // An ordinary owner session can still add a password and then use it to sign in.
    expect(await auth.api.setPassword({
      headers: new Headers({ cookie: member.cookie, origin }),
      body: { newPassword },
    })).toEqual({ status: true });
    const signedIn = await request("sign-in/email", { email: "member@example.com", password: newPassword });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({ user: { id: member.id } });
  });
});
