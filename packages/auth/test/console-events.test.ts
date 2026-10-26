import { afterEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@vite-hub/runtime";
import { createAuthConsole } from "../src/console-runtime.ts";
import { authConsoleEventGroups } from "../src/console-types.ts";
import { consoleEventsFixture } from "./fixtures/console-events.ts";
import { fixture } from "./fixtures/console.ts";
import type { AuthEvent, AuthEventStore } from "../src/events.ts";

const databases: Array<{ close(): void }> = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
async function data<T>(operation: Promise<Result<T>>) {
  const [error, value] = await operation;
  if (error) throw error;
  return value;
}
async function setup() {
  const app = await consoleEventsFixture();
  databases.push(app.database.sqlite);
  return app;
}

describe("Auth Console events", () => {
  it("shows real sign-up, sign-in and ban events in Overview, Activity and user history", async () => {
    const app = await setup();
    expect(
      (
        await app.request("sign-in/email", {
          email: "ada@example.com",
          password: "passwordpassword",
        })
      ).status,
    ).toBe(200);
    await data(
      app.api.execute(
        { action: "ban", userId: app.member.id, reason: "private-ban-reason" },
        app.operatorRequest,
      ),
    );
    const overview = await data(app.api.overview());
    expect(overview).toMatchObject({
      users: 2,
      newUsers: 2,
      activeUsers: 2,
      activeSessions: 1,
      analytics: {
        totals: { signIns: 3, signUps: 2, activeUsers: 2, methods: { "email-password": 3 } },
      },
    });
    expect(overview).not.toHaveProperty("approvedAgents");
    expect(overview.analytics?.days).toHaveLength(30);
    expect(overview.analytics?.days.at(-1)).toMatchObject({ signIns: 3, signUps: 2 });
    const activity = await data(app.api.activity({ userId: app.member.id }));
    for (const type of ["user.signed_up", "user.signed_in", "user.banned"])
      for (const page of [overview.recent, activity])
        expect(page.events.map((event) => event.type)).toContain(type);
    expect(activity.events.find((event) => event.type === "user.banned")).toMatchObject({
      actor: { id: app.operator.id, name: "Operator", available: true },
      subject: { id: app.member.id, name: "Ada Lovelace", available: true },
    });
    const serialized = JSON.stringify({ overview, activity });
    for (const secret of [
      "192.0.2.42",
      "private-user-agent",
      "passwordpassword",
      "private-ban-reason",
      app.member.token,
      app.operator.token,
    ])
      expect(serialized).not.toContain(secret);
    expect(activity.events.every((event) => !Object.hasOwn(event, "metadata"))).toBe(true);
  });

  it("filters groups and subject users before stable cursor pagination, including equal timestamps", async () => {
    const app = await setup();
    const time = new Date().toISOString();
    for (const [index, type] of Object.values(authConsoleEventGroups).flat().entries()) {
      await app.store.append({
        id: `group-${String(index).padStart(2, "0")}`,
        type,
        time,
        actor: `user:${app.operator.id}`,
        userId: app.member.id,
        metadata: {},
      });
    }
    const first = await data(app.api.activity({ group: "admin", userId: app.member.id, limit: 3 }));
    const second = await data(
      app.api.activity({
        group: "admin",
        userId: app.member.id,
        limit: 3,
        cursor: first.nextCursor,
      }),
    );
    expect(first.events).toHaveLength(3);
    expect(second.events).toHaveLength(3);
    expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(6);
    for (const group of ["sign-in", "admin", "agents", "organizations"] as const) {
      const page = await data(app.api.activity({ group, userId: app.member.id }));
      expect(page.events.length).toBeGreaterThan(0);
      expect(
        page.events.every(
          (event) =>
            authConsoleEventGroups[group].includes(event.type) &&
            event.subject?.id === app.member.id,
        ),
      ).toBe(true);
    }
    await app.store.append({
      id: "newer",
      type: "user.banned",
      time: new Date(Date.now() + 1).toISOString(),
      actor: "system",
      userId: app.member.id,
      metadata: {},
    });
    app.database.sqlite
      .prepare("DELETE FROM vitehub_auth_events WHERE id = ?")
      .run(first.events.at(-1)!.id);
    expect(
      (
        await data(
          app.api.activity({
            group: "admin",
            userId: app.member.id,
            limit: 3,
            cursor: first.nextCursor,
          }),
        )
      ).events,
    ).toEqual(second.events);
    expect((await app.api.activity({ cursor: "%" }))[0]?.code).toBe("AUTH_CONSOLE_INVALID_REQUEST");
    expect((await app.api.activity({ limit: 201 }))[0]?.code).toBe("AUTH_CONSOLE_INVALID_REQUEST");
  });

  it("counts distinct users across the week, zero-fills the chart and names missing users safely", async () => {
    const app = await setup();
    for (const days of [1, 3, 6])
      await app.store.append({
        id: `older-${days}`,
        type: "user.signed_in",
        time: new Date(Date.now() - days * 86400_000).toISOString(),
        actor: `user:${app.member.id}`,
        userId: app.member.id,
        metadata: { method: "oauth:github" },
      });
    expect((await data(app.api.overview())).activeUsers).toBe(2);
    await app.store.append({
      id: "missing-user",
      type: "user.removed",
      time: new Date().toISOString(),
      actor: "user:deleted-actor",
      userId: "deleted-subject",
      metadata: {},
    });
    expect((await data(app.api.activity({ userId: "deleted-subject" }))).events[0]).toMatchObject({
      actor: { id: "deleted-actor", available: false },
      subject: { id: "deleted-subject", available: false },
    });
  });

  it("keeps database totals and both pages when events are disabled", async () => {
    const { api } = await fixture();
    const description = await data(api.describe());
    expect(description.pages).toEqual([
      "overview",
      "users",
      "sessions",
      "organizations",
      "agents",
      "activity",
    ]);
    expect(description.events).toMatchObject({ enabled: false });
    expect(await data(api.overview())).toMatchObject({
      users: 2,
      activeSessions: 2,
      approvedAgents: 0,
      activeUsers: null,
      analytics: null,
      recent: { enabled: false, events: [] },
    });
    expect(await data(api.activity())).toEqual({ enabled: false, events: [] });
  });

  it("does not expose extra properties from a custom event store", async () => {
    const { auth } = await fixture();
    const event = {
      id: "safe",
      type: "user.banned",
      time: new Date().toISOString(),
      actor: "system",
      userId: null,
      metadata: { token: "secret-metadata" },
      token: "secret-event",
    } as AuthEvent;
    const counts = { signIns: 0, signUps: 0, activeUsers: 0, methods: {} };
    const store: AuthEventStore = {
      append: async () => {},
      list: async () => ({ events: [event] }),
      aggregate: async () => ({
        days: [{ day: "2026-10-25", ...counts, token: "secret-day" }],
        totals: { ...counts, token: "secret-total" },
        token: "secret-aggregate",
      }),
    };
    expect(await data(createAuthConsole(auth, {}, store).activity())).toEqual({
      enabled: true,
      events: [{ id: "safe", type: "user.banned", time: event.time, actor: null, subject: null }],
    });
    expect((await data(createAuthConsole(auth, {}, store).overview())).analytics).toEqual({
      days: [{ day: "2026-10-25", ...counts }],
      totals: counts,
    });
  });
});
