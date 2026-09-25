import { envBridgeError, sanitizeEnvBridgeError } from "./bridge-error.ts";
import { SecretEnv } from "./secret.ts";
import type { EnvProvider, EnvProviderValues } from "./types.ts";

export type EnvPermission = "inspect" | "preview" | "replace" | "use";
export interface EnvActor {
  id: string;
  kind: "user" | "agent" | "service";
}
export interface EnvAccessContext {
  actor: EnvActor;
  /** Set only by trusted authentication or application code. */
  admin?: boolean;
  /** Optional credential/permission ceiling from a verified agent token. */
  scope?: readonly { key: string; permissions: readonly EnvPermission[] }[];
  traceId?: string;
  invocationId?: string;
}
export interface EnvGrant {
  actor: EnvActor;
  key: string;
  permissions: readonly EnvPermission[];
}
export interface EnvSecretMetadata {
  revision: string;
  updatedAt: string;
  preview?: string;
}
export interface EnvReplacement extends EnvSecretMetadata {
  activation: "next-resolution" | "restart" | "deploy";
}
export interface EnvSecretStore {
  inspect(key: string): Promise<EnvSecretMetadata | undefined>;
  read(key: string): Promise<{ value: string; revision?: string } | undefined>;
  replace(input: {
    key: string;
    value: string;
    expectedRevision: string | null;
  }): Promise<EnvReplacement>;
}
export interface EnvActivity {
  id: string;
  operationId: string;
  timestamp: string;
  actor: EnvActor;
  key: string;
  action: "inspect" | "preview" | "replace" | "resolve" | "use" | "grant" | "revoke";
  outcome: "started" | "succeeded" | "failed" | "denied";
  revision?: string;
  operation?: string;
  target?: EnvActor;
  permissions?: readonly EnvPermission[];
  traceId?: string;
  invocationId?: string;
}
export interface EnvAccessStore {
  append(event: EnvActivity): Promise<void>;
  activity(input: { key: string; before?: string; limit: number }): Promise<readonly EnvActivity[]>;
  grants(key: string): Promise<readonly EnvGrant[]>;
  setGrant(grant: EnvGrant): Promise<void>;
  revokeGrant(actor: EnvActor, key: string): Promise<void>;
}
export interface EnvBridgeOptions {
  secrets: EnvSecretStore;
  access: EnvAccessStore;
  /** Derive runtime attribution from trusted invocation/request context. */
  runtimeContext: () => EnvAccessContext | Promise<EnvAccessContext>;
  /** Export already persisted events, for example through evlog. */
  emit?: (event: EnvActivity) => void | Promise<void>;
}
export interface EnvBridge extends EnvProvider {
  permissions(context: EnvAccessContext, key: string): Promise<readonly EnvPermission[]>;
  inspect(context: EnvAccessContext, key: string): Promise<EnvSecretMetadata | undefined>;
  preview(context: EnvAccessContext, key: string): Promise<EnvSecretMetadata | undefined>;
  replace(
    context: EnvAccessContext,
    input: { key: string; value: string; expectedRevision: string | null },
  ): Promise<EnvReplacement>;
  use<T>(
    context: EnvAccessContext,
    key: string,
    operation: string,
    run: (secret: SecretEnv<string>) => T | Promise<T>,
  ): Promise<T>;
  activity(
    context: EnvAccessContext,
    key: string,
    before?: string,
  ): Promise<readonly EnvActivity[]>;
  grants(context: EnvAccessContext, key: string): Promise<readonly EnvGrant[]>;
  grant(context: EnvAccessContext, grant: EnvGrant): Promise<void>;
  revoke(context: EnvAccessContext, actor: EnvActor, key: string): Promise<void>;
}

function identifier(value: string): void {
  if (!value || value.length > 512 || /[\u0000-\u001f]/.test(value))
    throw envBridgeError("invalid");
}

function validateActor(actor: EnvActor): void {
  identifier(actor.id);
  if (!["user", "agent", "service"].includes(actor.kind)) throw envBridgeError("invalid");
}

async function safe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw sanitizeEnvBridgeError(error);
  }
}

export function createEnvBridge(options: EnvBridgeOptions): EnvBridge {
  async function persist(event: EnvActivity): Promise<void> {
    try {
      await options.access.append(event);
    } catch {
      throw envBridgeError("audit_failed");
    }
    // Export cannot undo a persisted operation. Durable activity is the source of truth.
    try {
      await options.emit?.(structuredClone(event));
    } catch {}
  }
  async function allowed(
    context: EnvAccessContext,
    key: string,
    permission: EnvPermission | "admin",
  ): Promise<boolean> {
    identifier(key);
    validateActor(context.actor);
    if (
      context.scope &&
      (permission === "admin" ||
        !context.scope.some((grant) => grant.key === key && grant.permissions.includes(permission)))
    )
      return false;
    if (context.admin) return true;
    if (permission === "admin") return false;
    const grants = await safe(() => options.access.grants(key));
    return grants.some(
      (grant) =>
        grant.actor.id === context.actor.id &&
        grant.actor.kind === context.actor.kind &&
        grant.permissions.includes(permission),
    );
  }
  async function audited<T>(
    context: EnvAccessContext,
    key: string,
    action: EnvActivity["action"],
    permission: EnvPermission | "admin",
    run: () => Promise<T>,
    operation?: string,
    metadata?: {
      revision?: () => string | undefined;
      target?: EnvActor;
      permissions?: readonly EnvPermission[];
    },
  ): Promise<T> {
    identifier(key);
    validateActor(context.actor);
    const operationId = crypto.randomUUID();
    const base = {
      operationId,
      actor: { id: context.actor.id, kind: context.actor.kind },
      key,
      action,
      ...(context.traceId ? { traceId: context.traceId } : {}),
      ...(context.invocationId ? { invocationId: context.invocationId } : {}),
      ...(operation ? { operation } : {}),
      ...(metadata?.target ? { target: metadata.target } : {}),
      ...(metadata?.permissions ? { permissions: metadata.permissions } : {}),
    };
    const event = (outcome: EnvActivity["outcome"]): EnvActivity => ({
      ...base,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      outcome,
    });
    if (!(await allowed(context, key, permission))) {
      await persist(event("denied"));
      throw envBridgeError("denied");
    }
    await persist(event("started"));
    let value: T;
    try {
      value = await run();
    } catch (error) {
      const revision = metadata?.revision?.();
      await persist({ ...event("failed"), ...(revision ? { revision } : {}) });
      throw sanitizeEnvBridgeError(error);
    }
    const revision = metadata?.revision?.();
    await persist({ ...event("succeeded"), ...(revision ? { revision } : {}) });
    return value;
  }
  const bridge: EnvBridge = {
    async permissions(context, key) {
      const permissions: EnvPermission[] = ["inspect", "preview", "replace", "use"];
      const allowedPermissions = await Promise.all(
        permissions.map(async (permission) =>
          (await allowed(context, key, permission)) ? permission : undefined,
        ),
      );
      return allowedPermissions.filter(
        (permission): permission is EnvPermission => permission !== undefined,
      );
    },
    async read({ keys, signal, access }): Promise<EnvProviderValues> {
      const context = access ?? (await options.runtimeContext());
      const values: Array<[string, string | undefined]> = [];
      for (const key of keys) {
        signal?.throwIfAborted();
        let revision: string | undefined;
        const secret = await audited(
          context,
          key,
          "resolve",
          "use",
          async () => {
            const secret = await options.secrets.read(key);
            revision = secret?.revision;
            return secret;
          },
          undefined,
          { revision: () => revision },
        );
        signal?.throwIfAborted();
        values.push([key, secret?.value]);
      }
      return Object.fromEntries(values);
    },
    inspect: (context, key) =>
      audited(context, key, "inspect", "inspect", async () => {
        const value = await options.secrets.inspect(key);
        return value ? { revision: value.revision, updatedAt: value.updatedAt } : undefined;
      }),
    preview: (context, key) =>
      audited(context, key, "preview", "preview", async () => {
        const value = await options.secrets.inspect(key);
        return value ? { revision: value.revision, updatedAt: value.updatedAt, ...(value.preview ? { preview: value.preview } : {}) } : undefined;
      }),
    replace: (context, input) => {
      let revision: string | undefined;
      return audited(
        context,
        input.key,
        "replace",
        "replace",
        async () => {
          if (!input.value || new TextEncoder().encode(input.value).length > 32_768)
            throw envBridgeError("invalid");
          const replacement = await options.secrets.replace(input);
          revision = replacement.revision;
          return replacement;
        },
        undefined,
        { revision: () => revision },
      );
    },
    use: (context, key, operation, run) => {
      identifier(operation);
      let revision: string | undefined;
      return audited(
        context,
        key,
        "use",
        "use",
        async () => {
          const secret = await options.secrets.read(key);
          if (!secret) throw envBridgeError("missing");
          revision = secret.revision;
          return await run(new SecretEnv(secret.value));
        },
        operation,
        { revision: () => revision },
      );
    },
    async activity(context, key, before) {
      if (!(await allowed(context, key, "admin"))) throw envBridgeError("denied");
      return await safe(() => options.access.activity({ key, before, limit: 100 }));
    },
    async grants(context, key) {
      if (!(await allowed(context, key, "admin"))) throw envBridgeError("denied");
      return await safe(() => options.access.grants(key));
    },
    async grant(context, grant) {
      validateActor(grant.actor);
      if (!grant.permissions.length || grant.permissions.some(permission => !["inspect", "preview", "replace", "use"].includes(permission))) throw envBridgeError("invalid");
      return audited(context, grant.key, "grant", "admin", () => options.access.setGrant(grant), undefined, { target: grant.actor, permissions: grant.permissions });
    },
    async revoke(context, actor, key) {
      validateActor(actor);
      return audited(context, key, "revoke", "admin", () => options.access.revokeGrant(actor, key), undefined, { target: actor });
    },
  };
  return bridge;
}
