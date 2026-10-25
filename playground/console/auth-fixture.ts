import type {
  AuthConsoleAgent,
  AuthConsoleDescription,
  AuthConsoleList,
  AuthConsoleMutation,
  AuthConsoleOrganization,
  AuthConsoleQuery,
  AuthConsoleSession,
  AuthConsoleUser,
} from "../../packages/auth/src/console-types.ts";

const now = "2026-10-25T10:30:00.000Z";
const created = "2026-09-12T08:00:00.000Z";
const names = [
  "Lena Hoff",
  "Tomás Ribeiro",
  "Aiko Tanaka",
  "Sam Okafor",
  "Priya Nair",
  "Jonas Berg",
  "Nora Chen",
  "Alex Rivera",
];
const users: AuthConsoleUser[] = Array.from({ length: 1048 }, (_, index) => ({
  id: `user-${String(index + 1).padStart(4, "0")}`,
  name: names[index % names.length]! + (index >= 8 ? ` ${index + 1}` : ""),
  email: `${names[index % names.length]!.split(" ")[0]!.toLowerCase()}${index >= 8 ? index + 1 : ""}@example.com`,
  image: null,
  role: index === 0 || index === 2 ? "admin" : "user",
  banned: index === 5,
  banReason: index === 5 ? "Repeated unwanted uploads" : null,
  banExpires: null,
  createdAt: created,
  lastActive: index === 5 ? "2026-10-01T09:00:00.000Z" : now,
  providers: index % 3 === 1 ? ["credential"] : index === 0 ? ["github", "google"] : ["github"],
  fields: {
    plan: index % 3 === 0 ? "pro" : "free",
    projects: [87, 9, 133, 4, 21, 2, 34, 11][index % 8]!,
  },
}));
const sessions: AuthConsoleSession[] = users
  .slice(0, 8)
  .flatMap((user, index) =>
    index === 5
      ? []
      : [
          {
            id: `session-${index}`,
            user,
            device: index % 2 ? "Safari · iOS" : "Chrome · macOS",
            createdAt: created,
            updatedAt: now,
            expiresAt: "2026-11-24T10:30:00.000Z",
          },
        ],
  );
const agents: AuthConsoleAgent[] = [0, 2, 4].map((index, i) => ({
  id: `consent-${i}`,
  clientId: `client-${i}`,
  name: ["Claude Code", "Cursor", "Research assistant"][i]!,
  user: users[index]!,
  scopes: ["openid", "profile", "projects:read"],
  createdAt: created,
  lastUsed: null,
}));
const organizations: AuthConsoleOrganization[] = [
  { id: "org-1", name: "Studio North", slug: "studio-north", createdAt: created },
  { id: "org-2", name: "Launch team", slug: "launch-team", createdAt: created },
];
const enabled = { enabled: true };
const grantLimit = {
  enabled: false,
  reason:
    "Better Auth has no admin endpoint to revoke one user's client grant. Deleting a consent alone does not revoke issued tokens.",
};
const description: AuthConsoleDescription = {
  pages: ["users", "sessions", "organizations", "agents"],
  storage: enabled,
  access: [
    "Only invited email addresses can sign in.",
    "Members of the configured GitHub organization can sign in.",
  ],
  actions: {
    ban: enabled,
    unban: enabled,
    remove: enabled,
    revokeSession: enabled,
    revokeSessions: enabled,
    editField: enabled,
    impersonate: { enabled: false, reason: "Impersonation is disabled in this playground." },
    setRole: { enabled: false, reason: "Roles come from the app's administrator list." },
    revokeConsent: grantLimit,
  },
  fields: [
    {
      key: "plan",
      label: "Plan",
      type: "string",
      values: ["free", "pro"],
      required: false,
      computed: false,
      edit: enabled,
    },
    {
      key: "projects",
      label: "Projects",
      type: "number",
      required: false,
      computed: true,
      edit: { enabled: false, reason: "Computed by the app." },
    },
  ],
};
function page<T>(items: T[], query: AuthConsoleQuery = {}): AuthConsoleList<T> {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 25;
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

/** Synthetic data only. Real Better Auth proof lives in packages/auth/test/console.test.ts. */
export function authFixture(input: unknown): unknown {
  const command = input as {
    operation?: string;
    id?: string;
    query?: AuthConsoleQuery;
  } & AuthConsoleMutation;
  const user = users.find(
    (user) => user.id === ("userId" in command ? command.userId : command.id),
  );
  const query = command.query ?? {};
  switch (command.operation) {
    case "describe":
      return description;
    case "users":
      return page(
        users.filter(
          (user) =>
            (!query.search ||
              `${user.name} ${user.email}`.toLowerCase().includes(query.search.toLowerCase())) &&
            (!query.filter ||
              query.filter === "all" ||
              (query.filter === "admins"
                ? user.role === "admin"
                : query.filter === "banned"
                  ? user.banned
                  : agents.some((client) => client.user.id === user.id))),
        ),
        query,
      );
    case "user":
      if (user)
        return {
          user,
          accountsTotal: user.providers.length,
          organizationsTotal: 1,
          sessions: page(sessions.filter((session) => session.user.id === user.id)),
          accounts: user.providers.map((provider, i) => ({
            id: `${user.id}-${i}`,
            provider,
            accountId: `${user.id}-${provider}`,
            createdAt: created,
          })),
          agents: page(agents.filter((client) => client.user.id === user.id)),
          organizations: [
            { ...organizations[0], role: user.role === "admin" ? "owner" : "member" },
          ],
        };
      break;
    case "sessions":
      return page(
        sessions.filter((session) => !query.userId || session.user.id === query.userId),
        query,
      );
    case "agents":
      return page(
        agents.filter((client) => !query.userId || client.user.id === query.userId),
        query,
      );
    case "organizations":
      return page(organizations, query);
    case "organization":
      return {
        ...organizations.find((org) => org.id === command.id),
        members: users
          .slice(0, 4)
          .map((user) => ({
            id: `member-${user.id}`,
            role: user.role === "admin" ? "owner" : "member",
            user,
          })),
        membersTotal: 4,
        invitations: [
          {
            id: "invite-1",
            email: "jules@example.com",
            role: "member",
            expiresAt: "2026-11-01T12:00:00.000Z",
          },
        ],
        invitationsTotal: 1,
      };
  }
  if (command.action === "revokeSession") {
    const index = sessions.findIndex((session) => session.id === command.id);
    if (index >= 0) sessions.splice(index, 1);
  } else if (user && command.action === "ban") {
    user.banned = true;
    user.banReason = command.reason ?? null;
    for (let i = sessions.length - 1; i >= 0; i--)
      if (sessions[i]!.user.id === user.id) sessions.splice(i, 1);
  } else if (user && command.action === "unban") user.banned = false;
  else if (user && command.action === "editField" && command.field === "plan")
    user.fields.plan = command.value;
  else if (user && command.action === "remove") users.splice(users.indexOf(user), 1);
  else if (user && command.action === "revokeSessions") {
    for (let i = sessions.length - 1; i >= 0; i--)
      if (sessions[i]!.user.id === user.id) sessions.splice(i, 1);
  } else throw new Error("Unsupported synthetic Auth operation.");
  return { ok: true, actor: "user:playground-admin", action: command.action };
}
