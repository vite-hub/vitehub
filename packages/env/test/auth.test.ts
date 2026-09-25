import { describe, expect, it, vi } from "vitest";
import { createEnvAuthenticator } from "../src/auth.ts";

const human = { user: { id: "owner", role: "admin" } };
const agent = {
  agent: { id: "reviewer", capabilityGrants: [{ capability: "github-review", status: "active" }] },
  user: human.user,
};
const request = (authorization?: string) =>
  new Request("https://console.example/env", {
    headers: { cookie: "owner-session", ...(authorization ? { authorization } : {}) },
  });
function setup() {
  const getSession = vi.fn(async () => human);
  const isAdmin = vi.fn(() => true);
  const getAgentSession = vi.fn(async () => agent);
  const scope = vi.fn(() => [{ key: "github/token", permissions: ["use" as const] }]);
  return {
    getSession,
    isAdmin,
    getAgentSession,
    scope,
    authenticate: createEnvAuthenticator({
      getSession,
      isAdmin,
      agents: { getSession: getAgentSession, scope },
    }),
  };
}

describe("Env authentication", () => {
  it("uses the human policy and preserves request headers", async () => {
    const app = setup();
    const input = request();
    expect(await app.authenticate(input)).toEqual({
      actor: { kind: "user", id: "owner" },
      admin: true,
    });
    expect(app.getSession).toHaveBeenCalledWith({ headers: input.headers });
    app.isAdmin.mockReturnValue(false);
    expect((await app.authenticate(request()))?.admin).toBe(false);
  });

  it("keeps the agent identity and scope even when its user is an administrator", async () => {
    const app = setup();
    expect(await app.authenticate(request("Bearer verified-token"))).toEqual({
      actor: { kind: "agent", id: "reviewer" },
      scope: [{ key: "github/token", permissions: ["use"] }],
    });
    expect(app.getSession).not.toHaveBeenCalled();
    expect(app.isAdmin).not.toHaveBeenCalled();
    expect(app.scope).toHaveBeenCalledWith(agent);
  });

  it("never falls back to cookies after failed agent verification", async () => {
    const app = setup();
    app.getAgentSession.mockRejectedValue(new Error("expired"));
    expect(await app.authenticate(request("Bearer expired"))).toBeNull();
    expect(await app.authenticate(request("Basic invalid"))).toBeNull();
    expect(app.getSession).not.toHaveBeenCalled();
  });

  it("fails closed when scope mapping fails and preserves an empty ceiling", async () => {
    const app = setup();
    app.scope.mockImplementation(() => {
      throw new Error("unsupported constraints");
    });
    expect(await app.authenticate(request("Bearer token"))).toBeNull();
    app.scope.mockReturnValue([]);
    expect((await app.authenticate(request("Bearer token")))?.scope).toEqual([]);
  });

  it("fails closed when human session or policy verification fails", async () => {
    const app = setup();
    app.isAdmin.mockImplementation(() => {
      throw new Error("policy unavailable");
    });
    expect(await app.authenticate(request())).toBeNull();
    const authenticate = createEnvAuthenticator({
      getSession: async () => null,
      isAdmin: () => true,
    });
    expect(await authenticate(request())).toBeNull();
    expect(await authenticate(request("Bearer token"))).toBeNull();
  });
});
