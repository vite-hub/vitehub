import type { BetterAuthOptions, DBAdapter, User, Where } from "better-auth";
import { defineErrors, type Result } from "@vite-hub/runtime";
import { defineGrant } from "@vite-hub/runtime/internal/grant";
import { authConsoleActionNames, authConsoleEventGroups } from "./console-types.ts";
import { parseAuthEventList } from "./events.ts";
import type { AuthEventCounts, AuthEventListInput, AuthEventStore } from "./events.ts";
import type {
  AuthConsoleAction,
  AuthConsoleActivity,
  AuthConsoleActivityQuery,
  AuthConsoleEventUser,
  AuthConsoleOverview,
  AuthConsoleAgent,
  AuthConsoleCapability,
  AuthConsoleDescription,
  AuthConsoleField,
  AuthConsoleHostOptions,
  AuthConsoleList,
  AuthConsoleMutation,
  AuthConsoleOptions,
  AuthConsoleOrganization,
  AuthConsoleOrganizationDetail,
  AuthConsolePolicy,
  AuthConsoleQuery,
  AuthConsoleSession,
  AuthConsoleUser,
  AuthConsoleUserDetail,
  AuthConsoleValue,
} from "./console-types.ts";

export type * from "./console-types.ts";

export interface AuthConsole {
  describe(request?: Request): Promise<Result<AuthConsoleDescription, AuthConsoleErrorCode>>;
  overview(): Promise<Result<AuthConsoleOverview, AuthConsoleErrorCode>>;
  activity(
    query?: AuthConsoleActivityQuery,
  ): Promise<Result<AuthConsoleActivity, AuthConsoleErrorCode>>;
  users(
    query?: AuthConsoleQuery,
  ): Promise<Result<AuthConsoleList<AuthConsoleUser>, AuthConsoleErrorCode>>;
  /** With `request`, the impersonation target check also counts the `impersonate-admins` permission of its session. */
  user(id: string, request?: Request): Promise<Result<AuthConsoleUserDetail, AuthConsoleErrorCode>>;
  sessions(
    query?: AuthConsoleQuery,
  ): Promise<Result<AuthConsoleList<AuthConsoleSession>, AuthConsoleErrorCode>>;
  organizations(
    query?: AuthConsoleQuery,
  ): Promise<Result<AuthConsoleList<AuthConsoleOrganization>, AuthConsoleErrorCode>>;
  organization(
    id: string,
    query?: AuthConsoleQuery,
  ): Promise<Result<AuthConsoleOrganizationDetail, AuthConsoleErrorCode>>;
  agents(
    query?: AuthConsoleQuery,
  ): Promise<Result<AuthConsoleList<AuthConsoleAgent>, AuthConsoleErrorCode>>;
  execute(
    input: AuthConsoleMutation,
    request: Request,
  ): Promise<Result<Response, AuthConsoleErrorCode>>;
  /** End the impersonation of the request's app session and restore the administrator's session cookies. */
  stopImpersonating(request: Request): Promise<Result<Response, AuthConsoleErrorCode>>;
}

type ConsoleAdapter = Pick<DBAdapter, "findMany" | "findOne" | "count">;

type Row = Record<string, unknown>;
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const date = (value: unknown): string => {
  const parsed =
    value instanceof Date
      ? value
      : new Date(typeof value === "string" || typeof value === "number" ? value : NaN);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
};
const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const disabled = (reason: string): AuthConsoleCapability => ({ enabled: false, reason });
const policyReason = (policy: AuthConsolePolicy | undefined): string | undefined =>
  policy === false
    ? "Read-only in the Auth Definition."
    : typeof policy === "object"
      ? policy.reason || "Read-only in the Auth Definition."
      : undefined;
const userSummary = (user: Row) => ({
  id: string(user.id),
  name: string(user.name),
  email: string(user.email),
  image: typeof user.image === "string" ? user.image : null,
});
const equality = (field: string, value: string): Where[] => [{ field, value }];
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** The admin plugin options, with roles and user ids read as Better Auth reads them. */
function adminPlugin(options: BetterAuthOptions) {
  const plugin = options.plugins?.find((plugin) => plugin.id === "admin");
  const settings = record(plugin?.options);
  const configured = settings.adminRoles ?? ["admin"];
  return {
    settings,
    roles: (Array.isArray(configured) ? strings(configured) : string(configured).split(",")).map(
      (role) => role.trim(),
    ),
    userIds: strings(settings.adminUserIds),
  };
}
const endpoints: Record<Exclude<AuthConsoleAction, "revokeConsent">, string> = {
  ban: "banUser",
  unban: "unbanUser",
  remove: "removeUser",
  revokeSession: "revokeUserSession",
  revokeSessions: "revokeUserSessions",
  setRole: "setRole",
  editField: "adminUpdateUser",
  impersonate: "impersonateUser",
};
const permissions: Record<Exclude<AuthConsoleAction, "revokeConsent">, Record<string, string[]>> = {
  ban: { user: ["ban"] },
  unban: { user: ["ban"] },
  remove: { user: ["delete"] },
  revokeSession: { session: ["revoke"] },
  revokeSessions: { session: ["revoke"] },
  setRole: { user: ["set-role"] },
  editField: { user: ["update"] },
  impersonate: { user: ["impersonate"] },
};

class AuthConsoleError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthConsoleError";
  }
}

const errors = defineErrors({
  docs: "https://vitehub.dev/docs/auth/limits-and-errors",
  codes: {
    AUTH_CONSOLE_INVALID_REQUEST: {
      why: "The Auth Console request does not match its field or pagination contract.",
      fix: "Use a declared field value and a limit from 1 to 100.",
    },
    AUTH_CONSOLE_FORBIDDEN: {
      why: "The app policy or Better Auth session does not permit this action.",
      fix: "Check describe(request) for the disabled action reason and use an app admin session.",
    },
    AUTH_CONSOLE_NOT_FOUND: {
      why: "The requested Auth record or plugin is not available.",
      fix: "Refresh the list and check the Auth Definition's plugins.",
    },
    AUTH_CONSOLE_UNAVAILABLE: {
      why: "Auth does not have the database or plugin API needed for this operation.",
      fix: "Configure a database adapter and the required Better Auth plugin.",
    },
    AUTH_CONSOLE_PROVIDER_FAILED: {
      why: "Better Auth or an app column reader could not complete the operation.",
      fix: "Inspect the server-side cause and check the provider configuration.",
    },
  },
});
export type AuthConsoleErrorCode =
  | "AUTH_CONSOLE_INVALID_REQUEST"
  | "AUTH_CONSOLE_FORBIDDEN"
  | "AUTH_CONSOLE_NOT_FOUND"
  | "AUTH_CONSOLE_UNAVAILABLE"
  | "AUTH_CONSOLE_PROVIDER_FAILED";
async function result<T>(run: () => Promise<T>): Promise<Result<T, AuthConsoleErrorCode>> {
  try {
    return [undefined, await run()];
  } catch (cause) {
    const status = cause instanceof AuthConsoleError ? cause.status : 500;
    const code =
      status === 400
        ? "AUTH_CONSOLE_INVALID_REQUEST"
        : status === 401 || status === 403
          ? "AUTH_CONSOLE_FORBIDDEN"
          : status === 404
            ? "AUTH_CONSOLE_NOT_FOUND"
            : status === 409
              ? "AUTH_CONSOLE_UNAVAILABLE"
              : "AUTH_CONSOLE_PROVIDER_FAILED";
    return [errors[code]({ cause }), undefined];
  }
}

function pagination(query: AuthConsoleQuery): { offset: number; limit: number } {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 25;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new AuthConsoleError(400, "Use a non-negative offset and a limit from 1 to 100.");
  return { offset, limit };
}

function valueFor(value: unknown, field: AuthConsoleField): AuthConsoleValue {
  if (value === null || value === undefined) return null;
  if (field.type === "date") return date(value) || null;
  if (field.type === "string" && typeof value === "string") return value;
  if (field.type === "number" && typeof value === "number" && Number.isFinite(value)) return value;
  if (field.type === "boolean" && typeof value === "boolean") return value;
  if (
    field.type === "string[]" &&
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  )
    return value;
  if (
    field.type === "number[]" &&
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  )
    return value;
  if (field.type === "json") return JSON.stringify(value);
  return null;
}

/** Only additional fields that Better Auth allows in output reach the Console. */
export function describeAuthConsoleFields(
  options: BetterAuthOptions,
  policy: AuthConsoleOptions = {},
): AuthConsoleField[] {
  const fields: AuthConsoleField[] = [];
  for (const key of Object.keys(policy.fields ?? {})) {
    if (!Object.hasOwn(options.user?.additionalFields ?? {}, key))
      throw new AuthConsoleError(400, `The Console field ${key} is not an additional user field.`);
  }
  for (const [key, field] of Object.entries(options.user?.additionalFields ?? {})) {
    if (field.returned === false) continue;
    const configured = policy.fields?.[key];
    const values = Array.isArray(field.type) ? [...field.type] : undefined;
    const type = values ? "string" : field.type;
    const supported = ["string", "number", "boolean", "date", "string[]", "number[]"].includes(
      String(type),
    );
    fields.push({
      key,
      label: configured?.label ?? key,
      type: supported ? (type as AuthConsoleField["type"]) : "json",
      values,
      required: field.required === true,
      computed: false,
      edit:
        configured?.editable === true && supported
          ? { enabled: true }
          : disabled(configured?.reason ?? "This field is read-only in the Auth Definition."),
    });
  }
  for (const [key, column] of Object.entries(policy.columns ?? {})) {
    if (
      fields.some((field) => field.key === key) ||
      Object.hasOwn(options.user?.additionalFields ?? {}, key)
    )
      throw new AuthConsoleError(400, `The computed column ${key} conflicts with a user field.`);
    fields.push({
      key,
      label: column.label,
      type: column.type,
      required: false,
      computed: true,
      edit: disabled("Computed by the app."),
    });
  }
  return fields;
}

/**
 * Read and manage the app's Better Auth data from trusted server code. HTTP hosts must check access before calling it.
 * Writes require a real Better Auth session and pass through its plugin APIs. No adapter writes are used here.
 * Impersonation stays off unless `host.impersonation` is `true`.
 */
export function createAuthConsole(
  auth: { api: object; $context: Promise<{ adapter: ConsoleAdapter; options: BetterAuthOptions }> },
  policy: AuthConsoleOptions = {},
  events?: AuthEventStore,
  host: AuthConsoleHostOptions = {},
): AuthConsole {
  async function context() {
    return await auth.$context;
  }
  function endpoint(name: string) {
    const call: unknown = Reflect.get(auth.api, name);
    if (typeof call !== "function") return undefined;
    // Better Auth adds plugin endpoints at runtime. The plugin API validates each body itself.
    return call as (input: {
      headers: Headers;
      body?: Row;
      asResponse?: boolean;
      query?: Row;
    }) => Promise<unknown>;
  }
  async function call(
    name: string,
    request: Request,
    body?: Row,
    asResponse = false,
  ): Promise<unknown> {
    const run = endpoint(name);
    if (!run)
      throw new AuthConsoleError(409, "The required Better Auth plugin endpoint is not installed.");
    return await run({ headers: request.headers, body, asResponse });
  }
  /** The stored app session of the request, without a cookie cache read or a refresh write. */
  async function appSession(request: Request): Promise<{ session: Row; user: Row } | null> {
    const value = record(
      await endpoint("getSession")!({
        headers: request.headers,
        query: { disableCookieCache: true, disableRefresh: true },
      }),
    );
    return value.session && value.user
      ? { session: record(value.session), user: record(value.user) }
      : null;
  }
  async function permitted(request: Request, permissions: Record<string, string[]>) {
    try {
      return record(await call("userHasPermission", request, { permissions })).success === true;
    } catch {
      return false;
    }
  }
  async function features() {
    const ctx = await context();
    const ids = new Set(ctx.options.plugins?.map((plugin) => plugin.id));
    return {
      ctx,
      organization: ids.has("organization"),
      oauth: ids.has("oauth-provider"),
      mcp: ids.has("mcp"),
    };
  }
  async function describe(request?: Request): Promise<AuthConsoleDescription> {
    const { ctx, organization, oauth, mcp } = await features();
    const storage = ctx.options.database
      ? { enabled: true }
      : disabled(
          "Auth has no durable database. Configure a Better Auth database adapter to inspect stored users and sessions.",
        );
    const actions = {} as Record<AuthConsoleAction, AuthConsoleCapability>;
    const session =
      host.impersonation && request && storage.enabled
        ? await appSession(request).catch(() => null)
        : null;
    const impersonatedBy = string(session?.session.impersonatedBy);
    await Promise.all(
      authConsoleActionNames.map(async (action) => {
        let reason =
          action === "impersonate" && !host.impersonation
            ? "Impersonation is off in the Console configuration."
            : undefined;
        reason ??=
          policyReason(policy.actions?.[action]) ??
          (action === "setRole" ? policyReason(policy.roles) : undefined);
        if (!reason && !storage.enabled) reason = storage.reason;
        if (!reason && action === "revokeConsent")
          reason =
            "Better Auth has no admin endpoint to revoke one user's client grant. Deleting a consent alone does not revoke issued tokens.";
        if (!reason && action !== "revokeConsent" && !endpoint(endpoints[action]))
          reason = "Enable the Better Auth admin plugin.";
        // Every start and stop must leave a record that the Activity page can show.
        if (!reason && action === "impersonate" && !events)
          reason = "Add events.store to defineAuth() so that impersonation is recorded.";
        if (!reason && !request) reason = "Sign in with an app session to run this action.";
        if (!reason && action === "impersonate" && impersonatedBy)
          reason = "This browser already impersonates a user. Stop impersonating first.";
        if (!reason && request && action !== "revokeConsent") {
          try {
            const result = record(
              await call("userHasPermission", request, { permissions: permissions[action] }),
            );
            if (result.success !== true)
              reason = "Your app session does not have this Better Auth permission.";
          } catch {
            reason = "Sign in with an app admin session to run this action.";
          }
        }
        actions[action] = reason ? disabled(reason) : { enabled: true };
      }),
    );
    const fields = describeAuthConsoleFields(ctx.options, policy).map((field) => ({
      ...field,
      edit: field.edit.enabled && !actions.editField.enabled ? actions.editField : field.edit,
    }));
    return {
      access: [...(policy.access ?? [])],
      actions,
      fields,
      pages: [
        "overview",
        "users",
        "sessions",
        ...(organization ? ["organizations" as const] : []),
        ...(oauth || mcp ? ["agents" as const] : []),
        "activity",
      ],
      storage,
      events: events
        ? { enabled: true }
        : disabled("Add events.store to defineAuth() to record auth activity."),
      ...(host.impersonation
        ? {
            impersonation: {
              duration: impersonationDuration(ctx.options),
              active:
                impersonatedBy && session
                  ? {
                      user: userSummary(session.user),
                      expiresAt: date(session.session.expiresAt),
                    }
                  : null,
            },
          }
        : {}),
    };
  }
  /** Better Auth's default is one hour. */
  function impersonationDuration(options: BetterAuthOptions): number {
    const seconds = adminPlugin(options).settings.impersonationSessionDuration;
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  }
  /** Better Auth refuses banned users and, unless the admin plugin allows it, administrators. */
  async function impersonationTarget(row: Row, request?: Request): Promise<AuthConsoleCapability> {
    const ban = new Date(date(row.banExpires) || NaN).getTime();
    if (row.banned === true && !(ban < Date.now()))
      return disabled("Better Auth does not open sessions for banned users.");
    const admin = adminPlugin((await context()).options);
    const roles = (string(row.role) || string(admin.settings.defaultRole) || "user").split(",");
    const isAdmin =
      roles.some((role) => admin.roles.includes(role)) || admin.userIds.includes(string(row.id));
    if (
      isAdmin &&
      admin.settings.allowImpersonatingAdmins !== true &&
      !(request && (await permitted(request, { user: ["impersonate-admins"] })))
    )
      return disabled("Better Auth does not impersonate administrators.");
    return { enabled: true };
  }
  async function activity(query: AuthConsoleActivityQuery = {}): Promise<AuthConsoleActivity> {
    let input: AuthEventListInput;
    try {
      if (query.group !== undefined && !Object.hasOwn(authConsoleEventGroups, query.group))
        throw new TypeError("Unknown auth event group.");
      input = parseAuthEventList({
        type: query.group ? authConsoleEventGroups[query.group] : undefined,
        userId: query.userId,
        cursor: query.cursor,
        limit: query.limit ?? 25,
      }).query;
    } catch {
      throw new AuthConsoleError(400, "Invalid auth activity filters or cursor.");
    }
    if (!events) return { enabled: false, events: [] };
    const page = await events.list(input);
    const ids = [
      ...new Set(
        page.events.flatMap((event) => [
          ...(event.userId ? [event.userId] : []),
          ...(event.actor.startsWith("user:") ? [event.actor.slice(5)] : []),
        ]),
      ),
    ];
    const ctx = await context();
    // One bounded batch reads names only. No session, account, or additional fields enter this projection.
    const rows =
      ctx.options.database && ids.length
        ? await ctx.adapter.findMany<Row>({
            model: "user",
            where: [{ field: "id", operator: "in", value: ids }],
            select: ["id", "name"],
            limit: ids.length,
          })
        : [];
    const names = new Map(rows.map((row) => [string(row.id), string(row.name)]));
    const user = (id: string): AuthConsoleEventUser => ({
      id,
      name: names.get(id) || id,
      available: names.has(id),
    });
    return {
      enabled: true,
      events: page.events.map((event) => ({
        id: event.id,
        type: event.type,
        time: event.time,
        actor: event.actor.startsWith("user:") ? user(event.actor.slice(5)) : null,
        subject: event.userId ? user(event.userId) : null,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  async function overview(): Promise<AuthConsoleOverview> {
    const { ctx, oauth } = await features();
    const now = Date.now();
    const week = new Date(now - 7 * 86400_000);
    const today = new Date(now).toISOString().slice(0, 10);
    const window = {
      from: new Date(Date.parse(`${today}T00:00:00.000Z`) - 29 * 86400_000).toISOString(),
      to: new Date(now + 1).toISOString(),
    };
    const db = ctx.options.database ? ctx.adapter : undefined;
    const persistedSessions =
      db && (!ctx.options.secondaryStorage || ctx.options.session?.storeSessionInDatabase);
    const [users, newUsers, activeSessions, approvedAgents, analytics, recent, weekEvents] =
      await Promise.all([
        db ? db.count({ model: "user" }) : null,
        db
          ? db.count({
              model: "user",
              where: [
                { field: "createdAt", operator: "gte", value: week },
                { field: "createdAt", operator: "lte", value: new Date(now) },
              ],
            })
          : null,
        persistedSessions
          ? db.count({
              model: "session",
              where: [{ field: "expiresAt", operator: "gt", value: new Date(now) }],
            })
          : null,
        oauth ? (db ? db.count({ model: "oauthConsent" }) : null) : undefined,
        events ? events.aggregate(window) : null,
        activity({ limit: 8 }),
        events ? events.aggregate({ from: week.toISOString(), to: window.to }) : null,
      ]);
    const counts = (value: AuthEventCounts): AuthEventCounts => ({
      signIns: value.signIns,
      signUps: value.signUps,
      activeUsers: value.activeUsers,
      methods: Object.fromEntries(Object.entries(value.methods)),
    });
    return {
      users,
      newUsers,
      activeSessions,
      ...(oauth ? { approvedAgents } : {}),
      activeUsers: weekEvents?.totals.activeUsers ?? null,
      window,
      recent,
      analytics: analytics
        ? {
            days: analytics.days.map((day) => ({ day: day.day, ...counts(day) })),
            totals: counts(analytics.totals),
          }
        : null,
    };
  }
  async function adapter(): Promise<ConsoleAdapter> {
    const ctx = await context();
    if (!ctx.options.database)
      throw new AuthConsoleError(
        409,
        "Configure a Better Auth database adapter to inspect stored Auth data.",
      );
    return ctx.adapter;
  }
  async function find(model: string, where: Where[]): Promise<Row | null> {
    return await (await adapter()).findOne<Row>({ model, where });
  }
  async function list(
    model: string,
    query: AuthConsoleQuery,
    where: Where[] = [],
  ): Promise<AuthConsoleList<Row>> {
    const db = await adapter();
    const { offset, limit } = pagination(query);
    const [items, total] = await Promise.all([
      db.findMany<Row>({ model, where, offset, limit, sortBy: { field: "id", direction: "asc" } }),
      db.count({ model, where }),
    ]);
    return { items, total, offset, limit };
  }
  // Adapters have different mixed AND/OR rules. First get ids for the OR expression, then apply AND filters.
  // Batches keep database bind counts and memory use bounded for accounts with thousands of users.
  async function ids(model: string, field: string, where: Where[] = []): Promise<string[]> {
    const db = await adapter();
    const result = new Set<string>();
    for (let offset = 0; ; offset += 500) {
      const rows = await db.findMany<Row>({
        model,
        where,
        select: ["id", field],
        offset,
        limit: 500,
        sortBy: { field: "id", direction: "asc" },
      });
      for (const row of rows) if (typeof row[field] === "string") result.add(string(row[field]));
      if (rows.length < 500) return [...result].sort();
    }
  }
  async function users(query: AuthConsoleQuery = {}): Promise<AuthConsoleList<AuthConsoleUser>> {
    pagination(query);
    if (query.search && query.search.length > 200)
      throw new AuthConsoleError(400, "Search must have at most 200 characters.");
    if (query.filter && !["all", "admins", "banned", "agents"].includes(query.filter))
      throw new AuthConsoleError(400, "Unknown user filter.");
    const where: Where[] = [];
    const { ctx, oauth, mcp } = await features();
    if (query.filter === "banned") where.push({ field: "banned", value: true });
    if (
      ["banned", "admins"].includes(query.filter ?? "") &&
      !ctx.options.plugins?.some((plugin) => plugin.id === "admin")
    )
      return { ...pagination(query), total: 0, items: [] };
    let matches: string[] | undefined;
    if (query.search?.trim())
      matches = await ids("user", "id", [
        {
          field: "name",
          operator: "contains",
          value: query.search.trim(),
          mode: "insensitive",
          connector: "OR",
        },
        {
          field: "email",
          operator: "contains",
          value: query.search.trim(),
          mode: "insensitive",
          connector: "OR",
        },
      ]);
    if (query.filter === "admins") {
      const admin = adminPlugin(ctx.options);
      const matchesRole: Where[] = admin.roles.flatMap((role) => [
        { field: "role", value: role, connector: "OR" },
        { field: "role", value: `${role},`, operator: "starts_with", connector: "OR" },
        { field: "role", value: `,${role}`, operator: "ends_with", connector: "OR" },
        { field: "role", value: `,${role},`, operator: "contains", connector: "OR" },
      ]);
      const adminIds = new Set([
        ...(matchesRole.length ? await ids("user", "id", matchesRole) : []),
        ...admin.userIds,
      ]);
      matches = matches ? matches.filter((id) => adminIds.has(id)) : [...adminIds].sort();
    }
    if (query.filter === "agents") {
      const approved = oauth || mcp ? await ids("oauthConsent", "userId") : [];
      const approvedSet = new Set(approved);
      matches = matches ? matches.filter((id) => approvedSet.has(id)) : approved;
    }
    let result: AuthConsoleList<Row>;
    if (!matches) result = await list("user", query, where);
    else {
      const { offset, limit } = pagination(query);
      result = { offset, limit, total: 0, items: [] };
      for (let start = 0; start < matches.length; start += 400) {
        const batchWhere = [
          ...where,
          { field: "id", operator: "in" as const, value: matches.slice(start, start + 400) },
        ];
        const batch = await list(
          "user",
          { offset: Math.max(0, offset - result.total), limit },
          batchWhere,
        );
        result.total += batch.total;
        result.items.push(...batch.items.slice(0, limit - result.items.length));
      }
    }
    return { ...result, items: await enrichUsers(result.items) };
  }
  async function enrichUsers(rows: Row[]): Promise<AuthConsoleUser[]> {
    const db = await adapter();
    const fields = describeAuthConsoleFields((await context()).options, policy);
    const computed = new Map<string, Readonly<Record<string, AuthConsoleValue>>>();
    // Computed readers get public core user fields, never sessions, accounts, or credentials.
    const publicUsers: User[] = rows.map((row) => ({
      ...userSummary(row),
      emailVerified: row.emailVerified === true,
      createdAt: new Date(date(row.createdAt)),
      updatedAt: new Date(date(row.updatedAt)),
    }));
    await Promise.all(
      Object.entries(policy.columns ?? {}).map(async ([key, column]) => {
        computed.set(key, await column.read(publicUsers));
      }),
    );
    return await Promise.all(
      rows.map(async (row) => {
        const userId = string(row.id);
        const [accounts, recent] = await Promise.all([
          db.findMany<Row>({
            model: "account",
            where: equality("userId", userId),
            select: ["providerId"],
            limit: 100,
          }),
          db.findMany<Row>({
            model: "session",
            where: equality("userId", userId),
            select: ["updatedAt"],
            limit: 1,
            sortBy: { field: "updatedAt", direction: "desc" },
          }),
        ]);
        return {
          ...userSummary(row),
          role: string(row.role) || "user",
          banned: row.banned === true,
          banReason: typeof row.banReason === "string" ? row.banReason : null,
          banExpires: date(row.banExpires) || null,
          createdAt: date(row.createdAt),
          lastActive: date(recent[0]?.updatedAt) || null,
          providers: [...new Set(accounts.map((account) => string(account.providerId)))],
          fields: Object.fromEntries(
            fields.map((field) => [
              field.key,
              valueFor(field.computed ? computed.get(field.key)?.[userId] : row[field.key], field),
            ]),
          ),
        };
      }),
    );
  }
  async function sessions(
    query: AuthConsoleQuery = {},
  ): Promise<AuthConsoleList<AuthConsoleSession>> {
    const rows = await list("session", query, [
      { field: "expiresAt", operator: "gt", value: new Date() },
      ...(query.userId ? equality("userId", query.userId) : []),
    ]);
    return {
      ...rows,
      items: await Promise.all(
        rows.items.map(async (row) => ({
          id: string(row.id),
          user: userSummary(
            (await find("user", equality("id", string(row.userId)))) ?? { id: row.userId },
          ),
          device: authConsoleDevice(string(row.userAgent)),
          createdAt: date(row.createdAt),
          expiresAt: date(row.expiresAt),
          updatedAt: date(row.updatedAt),
        })),
      ),
    };
  }
  async function agents(query: AuthConsoleQuery = {}): Promise<AuthConsoleList<AuthConsoleAgent>> {
    const { oauth, mcp } = await features();
    if (!oauth && !mcp)
      throw new AuthConsoleError(
        404,
        "Enable the OAuth provider or MCP plugin to inspect approved clients.",
      );
    const rows = await list(
      "oauthConsent",
      query,
      query.userId ? equality("userId", query.userId) : [],
    );
    return {
      ...rows,
      items: await Promise.all(
        rows.items.map(async (row) => {
          const clientId = string(row.clientId);
          const client = await find(
            oauth ? "oauthClient" : "oauthApplication",
            equality("clientId", clientId),
          );
          return {
            id: string(row.id),
            clientId,
            name: string(client?.name) || clientId,
            user: userSummary(
              (await find("user", equality("id", string(row.userId)))) ?? { id: row.userId },
            ),
            scopes: Array.isArray(row.scopes)
              ? row.scopes.filter((value): value is string => typeof value === "string")
              : string(row.scopes).split(/[ ,]+/).filter(Boolean),
            createdAt: date(row.createdAt),
            lastUsed: date(row.lastUsedAt) || null,
          };
        }),
      ),
    };
  }
  function organizationRow(row: Row): AuthConsoleOrganization {
    return {
      id: string(row.id),
      name: string(row.name),
      slug: string(row.slug),
      createdAt: date(row.createdAt),
    };
  }
  async function organizations(
    query: AuthConsoleQuery = {},
  ): Promise<AuthConsoleList<AuthConsoleOrganization>> {
    if (!(await features()).organization)
      throw new AuthConsoleError(404, "Enable the Better Auth organization plugin.");
    const rows = await list("organization", query);
    return { ...rows, items: rows.items.map(organizationRow) };
  }
  async function organization(
    id: string,
    query: AuthConsoleQuery = {},
  ): Promise<AuthConsoleOrganizationDetail> {
    if (!(await features()).organization)
      throw new AuthConsoleError(404, "Enable the Better Auth organization plugin.");
    const row = await find("organization", equality("id", id));
    if (!row) throw new AuthConsoleError(404, "Organization not found.");
    const [members, invitations] = await Promise.all([
      list("member", query, equality("organizationId", id)),
      list("invitation", query, [
        ...equality("organizationId", id),
        { field: "status", value: "pending" },
        { field: "expiresAt", value: new Date(), operator: "gt" },
      ]),
    ]);
    return {
      ...organizationRow(row),
      membersTotal: members.total,
      invitationsTotal: invitations.total,
      members: await Promise.all(
        members.items.map(async (member) => ({
          id: string(member.id),
          role: string(member.role),
          user: userSummary(
            (await find("user", equality("id", string(member.userId)))) ?? { id: member.userId },
          ),
        })),
      ),
      invitations: invitations.items.map((invitation) => ({
        id: string(invitation.id),
        email: string(invitation.email),
        role: string(invitation.role),
        expiresAt: date(invitation.expiresAt),
      })),
    };
  }
  async function user(id: string, request?: Request): Promise<AuthConsoleUserDetail> {
    const row = await find("user", equality("id", id));
    if (!row) throw new AuthConsoleError(404, "User not found.");
    const { oauth, mcp, organization } = await features();
    const [enriched, sessionRows, accounts, agentRows, memberships, target] = await Promise.all([
      enrichUsers([row]),
      sessions({ userId: id }),
      list("account", { limit: 100 }, equality("userId", id)),
      oauth || mcp ? agents({ userId: id }) : { items: [], total: 0, offset: 0, limit: 25 },
      organization
        ? list("member", { limit: 100 }, equality("userId", id))
        : { items: [], total: 0 },
      host.impersonation ? impersonationTarget(row, request) : undefined,
    ]);
    return {
      ...(target ? { impersonation: target } : {}),
      user: enriched[0]!,
      sessions: sessionRows,
      accountsTotal: accounts.total,
      organizationsTotal: memberships.total,
      accounts: accounts.items.map((account) => ({
        id: string(account.id),
        provider: string(account.providerId),
        accountId: string(account.accountId),
        createdAt: date(account.createdAt),
      })),
      agents: agentRows,
      organizations: (
        await Promise.all(
          memberships.items.map(async (membership) => {
            const org = await find(
              "organization",
              equality("id", string(membership.organizationId)),
            );
            return org ? { ...organizationRow(org), role: string(membership.role) } : undefined;
          }),
        )
      ).filter((org): org is AuthConsoleOrganization & { role: string } => Boolean(org)),
    };
  }
  const actionGrant = defineGrant(
    "vitehub.auth.console.action",
    (action: AuthConsoleAction) => action,
  );
  async function authorize(input: AuthConsoleMutation, request: Request) {
    const description = await describe(request);
    if (!description.actions[input.action]?.enabled)
      throw new AuthConsoleError(
        403,
        description.actions[input.action]?.reason ?? "Action not supported.",
      );
    if (input.action === "editField") {
      const field = description.fields.find((field) => field.key === input.field);
      if (!field?.edit.enabled || field.computed)
        throw new AuthConsoleError(403, field?.edit.reason ?? "Field not editable.");
      if (input.value === null ? field.required : valueFor(input.value, field) === null)
        throw new AuthConsoleError(400, "The value does not match the declared field type.");
      if (field.values && input.value !== null && !field.values.includes(String(input.value)))
        throw new AuthConsoleError(400, "Choose one of the declared field values.");
    }
    return actionGrant.issue(input.action);
  }
  async function mutate(
    input: AuthConsoleMutation,
    request: Request,
    grant: ReturnType<typeof actionGrant.issue>,
  ): Promise<Response> {
    if (actionGrant.consume(grant) !== input.action)
      throw new AuthConsoleError(403, "The action grant does not match.");
    let name: string;
    let body: Row;
    switch (input.action) {
      case "ban":
        if (
          input.expiresIn !== undefined &&
          (!Number.isSafeInteger(input.expiresIn) || input.expiresIn <= 0)
        )
          throw new AuthConsoleError(400, "Ban expiry must be a positive number of seconds.");
        name = endpoints.ban;
        body = { userId: input.userId, banReason: input.reason, banExpiresIn: input.expiresIn };
        break;
      case "editField":
        name = endpoints.editField;
        body = { userId: input.userId, data: { [input.field]: input.value } };
        break;
      case "setRole":
        name = endpoints.setRole;
        body = { userId: input.userId, role: input.role };
        break;
      case "revokeSession": {
        const session = await find("session", equality("id", input.id));
        if (!session) throw new AuthConsoleError(404, "Session not found.");
        name = endpoints.revokeSession;
        body = { sessionToken: string(session.token) };
        break;
      }
      case "revokeConsent":
        throw new AuthConsoleError(409, "Better Auth has no admin API to revoke this grant.");
      default:
        name = endpoints[input.action];
        body = { userId: input.userId };
    }
    const session = record(
      await endpoint("getSession")!({
        headers: request.headers,
        query: { disableCookieCache: true },
      }),
    );
    const actorId = string(record(session.user).id);
    if (!actorId)
      throw new AuthConsoleError(401, "Sign in with an app session to run this action.");
    const result = await call(name, request, body, true);
    if (!(result instanceof Response))
      throw new AuthConsoleError(502, "Better Auth returned an invalid action response.");
    if (!result.ok) {
      const failure = record(await result.json().catch(() => ({})));
      throw new AuthConsoleError(
        result.status,
        string(failure.message) || "Better Auth rejected the action.",
      );
    }
    const headers = new Headers({ "cache-control": "no-store" });
    // Impersonation needs HttpOnly cookies, but its session body must never reach the client.
    if (input.action === "impersonate")
      for (const cookie of result.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return Response.json(
      {
        action: input.action,
        actor: `user:${actorId}`,
        target: "id" in input ? input.id : input.userId,
        ok: true,
      },
      { headers },
    );
  }
  async function stopImpersonating(request: Request): Promise<Response> {
    if (!host.impersonation)
      throw new AuthConsoleError(403, "Impersonation is off in the Console configuration.");
    const response = await call("stopImpersonating", request, undefined, true);
    if (!(response instanceof Response))
      throw new AuthConsoleError(502, "Better Auth returned an invalid action response.");
    if (!response.ok) {
      const failure = record(await response.json().catch(() => ({})));
      throw new AuthConsoleError(
        response.status,
        string(failure.message) || "Better Auth could not stop the impersonation.",
      );
    }
    // Better Auth restores the administrator's session cookie. Its session body never reaches the client.
    const headers = new Headers({ "cache-control": "no-store" });
    for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return Response.json({ action: "stopImpersonating", ok: true }, { headers });
  }
  return {
    describe: (request) => result(() => describe(request)),
    overview: () => result(overview),
    activity: (query) => result(() => activity(query)),
    users: (query) => result(() => users(query)),
    user: (id, request) => result(() => user(id, request)),
    sessions: (query) => result(() => sessions(query)),
    organizations: (query) => result(() => organizations(query)),
    organization: (id, query) => result(() => organization(id, query)),
    agents: (query) => result(() => agents(query)),
    execute: (input, request) =>
      result(async () => await mutate(input, request, await authorize(input, request))),
    stopImpersonating: (request) => result(() => stopImpersonating(request)),
  };
}

/** A short device label. The full user agent is never returned to the browser. */
export function authConsoleDevice(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Unknown browser";
  const os = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Windows/.test(userAgent)
        ? "Windows"
        : /Macintosh/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "Unknown device";
  return `${browser} · ${os}`;
}
