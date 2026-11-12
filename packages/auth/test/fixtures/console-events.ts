import { getMigrations } from "better-auth/db/migration";
import { admin } from "better-auth/plugins";
import type { SecondaryStorage } from "better-auth";
import { defineAuth, createDatabaseAuthEventStore } from "../../src/index.ts";
import { createBetterAuthOptions, getAuthForDefinition } from "../../src/server.ts";
import { createAuthConsole } from "../../src/console-runtime.ts";
import { eventDatabase } from "../event-helpers.ts";

type AuthDefinitionPlugins = NonNullable<Parameters<typeof defineAuth>[0]>["plugins"];

/** A local Better Auth provider and durable SQLite event reader. No external service is used. */
export async function consoleEventsFixture(options: {
  plugins?: AuthDefinitionPlugins
  secondaryStorage?: SecondaryStorage
  /** The role of the operator account. `admin` by default. */
  operatorRole?: string
} = {}) {
  const database = eventDatabase();
  const store = createDatabaseAuthEventStore({ db: database.db });
  const origin = "http://localhost:5173";
  const definition = defineAuth({
    emailAndPassword: { enabled: true },
    plugins: options.plugins ?? [admin()],
    events: { store },
    runtime: {
      database: database.sqlite,
      ...(options.secondaryStorage ? { secondaryStorage: options.secondaryStorage } : {}),
      secret: "console-events-local-test-secret-abcdefghijklmnopqrstuvwxyz",
      baseURL: origin,
    },
  });
  try {
    await (await getMigrations(createBetterAuthOptions(definition))).runMigrations();
    const auth = getAuthForDefinition(definition);
    const request = (path: string, body: object, cookie = "") =>
      auth.handler(
        new Request(`${origin}/api/auth/${path}`, {
          method: "POST",
          headers: {
            origin,
            cookie,
            "content-type": "application/json",
            "x-forwarded-for": "192.0.2.42",
            "user-agent": "private-user-agent",
          },
          body: JSON.stringify(body),
        }),
      );
    const signup = async (name: string, email: string) => {
      const response = await request("sign-up/email", {
        name,
        email,
        password: "passwordpassword",
      });
      if (!response.ok) throw new Error(`Local sign-up failed: ${response.status}`);
      const value = (await response.json()) as { user: { id: string }; token: string };
      return {
        id: value.user.id,
        token: value.token,
        cookie: response.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; "),
      };
    };
    const operator = await signup("Operator", "operator@example.com");
    database.sqlite.prepare("UPDATE user SET role = ? WHERE id = ?").run(options.operatorRole ?? "admin", operator.id);
    const member = await signup("Ada Lovelace", "ada@example.com");
    const api = createAuthConsole(auth, {}, store);
    const operatorRequest = new Request(`${origin}/_vitehub/auth/manage`, {
      method: "POST",
      headers: { cookie: operator.cookie, origin },
    });
    return { api, auth, definition, database, store, request, operator, member, operatorRequest };
  } catch (error) {
    database.sqlite.close();
    throw error;
  }
}
