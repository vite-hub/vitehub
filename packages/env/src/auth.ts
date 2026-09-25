import type { EnvAccessContext, EnvPermission } from "./bridge.ts";

export interface EnvHumanSession {
  user: { id: string };
}
export interface EnvAgentSession {
  agent: { id: string };
}
export type EnvAgentScope = NonNullable<EnvAccessContext["scope"]>;

export interface EnvAuthenticatorOptions<
  Human extends EnvHumanSession,
  Agent extends EnvAgentSession,
> {
  /** Pass Better Auth's auth.api.getSession, preserving the incoming headers. */
  getSession(input: { headers: Headers }): Promise<Human | null>;
  /** Application policy; authentication alone never grants administrator access. */
  isAdmin(session: Human): boolean | Promise<boolean>;
  agents?: {
    /** Must verify the credential, e.g. auth.api.getAgentSession from Agent Auth. */
    getSession(input: { headers: Headers }): Promise<Agent | null>;
    /** Map verified capability grants AND their constraints to exact store keys. */
    scope(session: Agent): EnvAgentScope | null | Promise<EnvAgentScope | null>;
  };
}

const permissions: readonly EnvPermission[] = ["inspect", "preview", "replace", "use"];
function identifier(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f]/.test(value)
  );
}

/** Authenticate management requests without coupling Env to a particular Better Auth plugin version. */
export function createEnvAuthenticator<
  Human extends EnvHumanSession,
  Agent extends EnvAgentSession = EnvAgentSession,
>(
  options: EnvAuthenticatorOptions<Human, Agent>,
): (request: Request) => Promise<EnvAccessContext | null> {
  return async (request) => {
    try {
      const authorization = request.headers.get("authorization");
      // Never fall back to an owner's cookie when an agent credential is invalid.
      if (authorization !== null) {
        if (!/^Bearer\s+\S+$/i.test(authorization) || !options.agents) return null;
        const session = await options.agents.getSession({ headers: request.headers });
        if (!session || !identifier(session.agent.id)) return null;
        const scope = await options.agents.scope(session);
        if (
          !Array.isArray(scope) ||
          scope.some(
            (grant) =>
              !identifier(grant.key) ||
              !Array.isArray(grant.permissions) ||
              grant.permissions.some(
                (permission: EnvPermission) => !permissions.includes(permission),
              ),
          )
        )
          return null;
        return {
          actor: { kind: "agent", id: session.agent.id },
          scope: scope.map((grant) => ({ key: grant.key, permissions: [...grant.permissions] })),
        };
      }
      const session = await options.getSession({ headers: request.headers });
      if (!session || !identifier(session.user.id)) return null;
      return {
        actor: { kind: "user", id: session.user.id },
        admin: (await options.isAdmin(session)) === true,
      };
    } catch {
      return null;
    }
  };
}
