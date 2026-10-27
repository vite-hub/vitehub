import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, organization, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { expect, vi } from "vitest";
import { defineAuth } from "../../src/index.ts";
import { getAuthForDefinition } from "../../src/server.ts";
import { createAuthConsole } from "../../src/console-runtime.ts";

const origin = "http://localhost:3000";
export async function fixture(options: { admin?: boolean } = {}) {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    account: [],
    session: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
    jwks: [],
    oauthClient: [],
    oauthConsent: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
  };
  const updated = vi.fn();
  const definition = defineAuth({
    emailAndPassword: { enabled: true },
    user: {
      additionalFields: {
        plan: { type: ["free", "pro"], defaultValue: "free", required: false },
        internalNote: { type: "string", returned: false },
        quota: { type: "number", required: false },
        enabled: { type: "boolean", required: false },
        joined: { type: "date", required: false },
        tags: { type: "string[]", required: false },
      },
    },
    databaseHooks: { user: { update: { after: updated } } },
    plugins: [
      ...(options.admin === false ? [] : [admin()]),
      organization(),
      jwt(),
      oauthProvider({ loginPage: "/login", consentPage: "/consent" }),
    ],
    runtime: {
      database: memoryAdapter(db),
      secret: "vitehub-auth-console-test-secret-abcdefghijklmnopqrstuvwxyz",
      baseURL: origin,
    },
  });
  const auth = getAuthForDefinition(definition);
  const signup = async (name: string, email: string) => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ name, email, password: "passwordpassword" }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const body = (await response.json()) as { user: { id: string } };
    return {
      id: body.user.id,
      request: new Request(`${origin}/_vitehub/auth/manage`, {
        method: "POST",
        headers: { cookie, origin },
      }),
    };
  };
  const operator = await signup("Operator", "operator@example.com");
  if (options.admin !== false) db.user.find((user) => user.id === operator.id)!.role = "admin";
  const member = await signup("Ada Lovelace", "ada@example.com");
  const read = vi.fn((users: readonly { id: string }[]) =>
    Object.fromEntries(users.map((user) => [user.id, 7])),
  );
  const api = createAuthConsole(auth, {
    fields: { plan: { editable: true }, quota: { editable: true }, enabled: { editable: true }, joined: { editable: true }, tags: { editable: true } },
    columns: { projects: { type: "number", label: "Projects", read } },
    access: ["Invited users only."],
  });
  return { api, auth, db, operator, member, read, updated };
}
