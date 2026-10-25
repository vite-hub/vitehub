import type { Result } from "@vite-hub/runtime";
import { describe, expect, it } from "vitest";
import { createAuthConsole, describeAuthConsoleFields } from "../src/console-runtime.ts";
import { fixture } from "./fixtures/console.ts";

async function data<T>(operation: Promise<Result<T>>): Promise<T> {
  const [error, value] = await operation;
  if (error) throw error;
  return value;
}

describe("Auth Console with real Better Auth plugins", () => {
  it("lists safe fields, linked providers, active sessions, organizations and consents", async () => {
    const { api, auth, db, operator, member, read } = await fixture();
    const ctx = await auth.$context;
    await ctx.adapter.create({
      model: "organization",
      data: { id: "org-1", name: "Studio", slug: "studio", createdAt: new Date() },
      forceAllowId: true,
    });
    await ctx.adapter.create({
      model: "member",
      data: { organizationId: "org-1", userId: member.id, role: "member", createdAt: new Date() },
    });
    await ctx.adapter.create({
      model: "oauthClient",
      data: {
        clientId: "client-1",
        name: "Local agent",
        redirectUris: ["http://localhost/callback"],
        clientSecret: "client-secret-never-send",
        createdAt: new Date(),
      },
    });
    await ctx.adapter.create({
      model: "oauthConsent",
      data: {
        clientId: "client-1",
        userId: member.id,
        scopes: ["openid", "profile"],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    db.user.find((user) => user.id === member.id)!.internalNote = "private-never-send";
    const users = await data(api.users({ search: "ADA", limit: 1 }));
    expect(users.total).toBe(1);
    expect(users.items[0]).toMatchObject({
      id: member.id,
      providers: ["credential"],
      fields: { plan: "free", projects: 7 },
    });
    expect(read).toHaveBeenCalledOnce();
    const details = await data(api.user(member.id));
    expect(details.organizations[0]).toMatchObject({ name: "Studio", role: "member" });
    expect(details.agents.items[0]).toMatchObject({
      name: "Local agent",
      scopes: ["openid", "profile"],
      lastUsed: null,
    });
    expect((await data(api.users({ filter: "agents" }))).items.map((user) => user.id)).toEqual([
      member.id,
    ]);
    const serialized = JSON.stringify({
      users,
      details,
      sessions: await data(api.sessions()),
      description: await data(api.describe(operator.request)),
    });
    for (const forbidden of [
      "private-never-send",
      "client-secret-never-send",
      ...db.session.map((session) => session.token),
      ...db.account.map((account) => account.password),
    ])
      expect(serialized).not.toContain(String(forbidden));
    expect((await data(api.describe(operator.request))).pages).toEqual([
      "users",
      "sessions",
      "organizations",
      "agents",
    ]);
  });

  it("runs field updates, session revocation, ban and unban through Better Auth and its hooks", async () => {
    const { api, auth, db, operator, member, updated } = await fixture();
    const edited = await data(
      api.execute(
        { action: "editField", userId: member.id, field: "plan", value: "pro" },
        operator.request,
      ),
    );
    expect(await edited.json()).toMatchObject({
      actor: `user:${operator.id}`,
      action: "editField",
    });
    expect(db.user.find((user) => user.id === member.id)?.plan).toBe("pro");
    expect(updated).toHaveBeenCalled();
    const sessionId = (await data(api.sessions({ userId: member.id }))).items[0]!.id;
    await data(api.execute({ action: "revokeSession", id: sessionId }, operator.request));
    expect(
      await auth.api.getSession({
        headers: member.request.headers,
        query: { disableCookieCache: true },
      }),
    ).toBeNull();
    await data(
      api.execute(
        { action: "ban", userId: member.id, reason: "Fixture ban", expiresIn: 3600 },
        operator.request,
      ),
    );
    expect(db.user.find((user) => user.id === member.id)).toMatchObject({
      banned: true,
      banReason: "Fixture ban",
    });
    expect((await data(api.users({ filter: "banned" }))).total).toBe(1);
    await data(api.execute({ action: "unban", userId: member.id }, operator.request));
    expect(db.user.find((user) => user.id === member.id)?.banned).toBe(false);
  });

  it("fails closed for missing plugins, missing permissions, invalid field values and app policy", async () => {
    const { api, auth, member, operator } = await fixture();
    await expect(
      data(api.execute({ action: "ban", userId: operator.id }, member.request)),
    ).rejects.toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
    await expect(
      data(
        api.execute(
          { action: "editField", userId: member.id, field: "plan", value: "other" },
          operator.request,
        ),
      ),
    ).rejects.toMatchObject({ code: "AUTH_CONSOLE_INVALID_REQUEST" });
    await expect(
      data(
        api.execute(
          { action: "editField", userId: member.id, field: "role", value: "admin" },
          operator.request,
        ),
      ),
    ).rejects.toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
    const readOnly = createAuthConsole(auth, {
      roles: { editable: false, reason: "Roles come from the directory." },
      actions: { ban: false },
    });
    expect((await data(readOnly.describe(operator.request))).actions.setRole).toEqual({
      enabled: false,
      reason: "Roles come from the directory.",
    });
    await expect(
      data(readOnly.execute({ action: "ban", userId: member.id }, operator.request)),
    ).rejects.toMatchObject({ code: "AUTH_CONSOLE_FORBIDDEN" });
    const withoutAdmin = await fixture({ admin: false });
    expect(
      (await data(withoutAdmin.api.describe(withoutAdmin.operator.request))).actions.ban,
    ).toEqual({ enabled: false, reason: "Enable the Better Auth admin plugin." });
    expect((await data(api.describe(operator.request))).actions.revokeConsent.enabled).toBe(false);
  });

  it("edits numeric, boolean, date and array fields through Better Auth", async () => {
    const { api, member, operator } = await fixture();
    const values = { quota: 12, enabled: true, joined: "2026-10-25T10:00:00.000Z", tags: ["member", "early"] };
    for (const [field, value] of Object.entries(values)) await data(api.execute({ action: "editField", userId: member.id, field, value }, operator.request));
    const detail = await data(api.user(member.id));
    expect(detail.user.fields).toMatchObject(values);
  });

  it("matches exact admin roles and ignores role names that only contain admin", async () => {
    const { api, db, operator, member } = await fixture();
    db.user.find((user) => user.id === member.id)!.role = "superadmin";
    expect((await data(api.users({ filter: "admins" }))).items.map((user) => user.id)).toEqual([
      operator.id,
    ]);
    db.user.find((user) => user.id === member.id)!.role = "user,admin";
    expect(
      (await data(api.users({ filter: "admins", search: "ada" }))).items.map((user) => user.id),
    ).toEqual([member.id]);
  });

  it("returns safe typed errors for provider failures", async () => {
    const { auth } = await fixture();
    const inspect = createAuthConsole(auth, {
      columns: {
        broken: {
          label: "Broken",
          type: "number",
          read: () => {
            throw new Error("private-provider-detail");
          },
        },
      },
    });
    const [error, value] = await inspect.users();
    expect(value).toBeUndefined();
    expect(error?.code).toBe("AUTH_CONSOLE_PROVIDER_FAILED");
    expect(JSON.stringify(error)).not.toContain("private-provider-detail");
  });

  it("paginates thousands of users without duplicates and keeps name/email search filters correct", async () => {
    const { api, db } = await fixture();
    const createdAt = new Date();
    for (let index = 0; index < 1100; index++)
      db.user.push({
        id: `bulk-${String(index).padStart(4, "0")}`,
        name: "Synthetic",
        email: `person${index}@example.com`,
        role: "user",
        banned: index % 2 === 0,
        createdAt,
        updatedAt: createdAt,
      });
    const a = await data(api.users({ search: "person", filter: "banned", offset: 390, limit: 25 }));
    const b = await data(api.users({ search: "person", filter: "banned", offset: 415, limit: 25 }));
    expect(a.total).toBe(550);
    expect(a.items).toHaveLength(25);
    expect(b.items).toHaveLength(25);
    expect(new Set([...a.items, ...b.items].map((user) => user.id)).size).toBe(50);
    expect(a.items.every((user) => user.banned)).toBe(true);
  });
});

it("infers field controls from Better Auth and rejects computed column collisions", () => {
  const options = {
    user: {
      additionalFields: {
        count: { type: "number" as const },
        enabled: { type: "boolean" as const },
        joined: { type: "date" as const },
        hidden: { type: "string" as const, returned: false },
        plan: { type: ["free", "pro"] as ("free" | "pro")[] },
      },
    },
  };
  const fields = describeAuthConsoleFields(options, { fields: { plan: { editable: true } } });
  expect(fields.map((field) => [field.key, field.type])).toEqual([
    ["count", "number"],
    ["enabled", "boolean"],
    ["joined", "date"],
    ["plan", "string"],
  ]);
  expect(fields.find((field) => field.key === "plan")).toMatchObject({
    values: ["free", "pro"],
    edit: { enabled: true },
  });
  expect(() =>
    describeAuthConsoleFields(options, {
      columns: { plan: { label: "Plan", type: "number", read: () => ({}) } },
    }),
  ).toThrow("conflicts");
});
