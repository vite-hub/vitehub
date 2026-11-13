import type { User } from "better-auth";
import type { AuthEventAggregates, AuthEventType, AuthEventWindow } from "./events.ts";

export type AuthConsoleValue = string | number | boolean | null | string[] | number[];
export type AuthConsoleFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "string[]"
  | "number[]"
  | "json";
export type AuthConsoleAction =
  | "ban"
  | "unban"
  | "remove"
  | "revokeSession"
  | "revokeSessions"
  | "setRole"
  | "editField"
  | "impersonate"
  | "revokeConsent";
/** A reason makes the action read-only. `false` uses the default reason. */
export type AuthConsolePolicy = boolean | { editable: false; reason: string };

export interface AuthConsoleFieldPolicy {
  label?: string;
  /** Fields are read-only unless the app opts in. */
  editable?: boolean;
  reason?: string;
}

type ColumnValues<T> = Readonly<Record<string, T | null>>;
type ColumnReader<T> = (users: readonly User[]) => Promise<ColumnValues<T>> | ColumnValues<T>;
/** One server call per page. Return computed values keyed by user id. */
export type AuthConsoleColumn = { label: string } & (
  | { type: "string" | "date"; read: ColumnReader<string> }
  | { type: "number"; read: ColumnReader<number> }
  | { type: "boolean"; read: ColumnReader<boolean> }
);

/**
 * Roles that the app computes, such as from an environment variable. The Console shows them and its Admins filter
 * uses them. `null` keeps the stored role. Better Auth's own endpoints still read the stored `user.role`.
 */
export interface AuthConsoleRoles {
  editable: false;
  reason: string;
  read: ColumnReader<string>;
}

/** Host-independent display and edit policy. It does not grant Better Auth permissions. */
export interface AuthConsoleOptions {
  access?: readonly string[];
  actions?: Partial<Record<AuthConsoleAction, AuthConsolePolicy>>;
  columns?: Readonly<Record<string, AuthConsoleColumn>>;
  fields?: Readonly<Record<string, AuthConsoleFieldPolicy | undefined>>;
  roles?: AuthConsolePolicy | AuthConsoleRoles;
}

export interface AuthConsoleCapability {
  enabled: boolean;
  reason?: string;
}
export interface AuthConsoleField {
  key: string;
  label: string;
  type: AuthConsoleFieldType;
  values?: string[];
  required: boolean;
  computed: boolean;
  edit: AuthConsoleCapability;
}
export type AuthConsolePage =
  | "overview"
  | "activity"
  | "users"
  | "sessions"
  | "organizations"
  | "agents";
export interface AuthConsoleDescription {
  access: string[];
  actions: Record<AuthConsoleAction, AuthConsoleCapability>;
  fields: AuthConsoleField[];
  pages: AuthConsolePage[];
  storage: AuthConsoleCapability;
  events: AuthConsoleCapability;
  /** Present only when the host enables impersonation. */
  impersonation?: AuthConsoleImpersonation;
}

/** What the host allows. A host that renders the Console passes it with the Definition's own policy. */
export interface AuthConsoleHostOptions {
  /** Let the Console start and stop Better Auth admin impersonation. Off by default. */
  impersonation?: boolean;
  /**
   * A verified OAuth user and the token's login session. Trusted server hosts set this only after checking the token
   * and their access policy. Auth uses that stored session for its APIs; browser cookies cannot change the actor.
   * Tokens without a login session cannot run Auth changes. Impersonation always needs the browser session.
   */
  bearer?: { user: Pick<User, "id">; sessionId?: string };
  /**
   * The person of a signed ViteHub Console call. Trusted server hosts set this only after they check the signature and
   * their access policy. Auth changes run as the app user with this email, with the newest live app session of that
   * user that is not an impersonation, and only inside this API. Browser cookies cannot change the actor. Without an
   * app user or a live session, Auth changes are refused. Impersonation always needs the browser session.
   */
  actor?: { email: string };
}

/** The app session of a request, as `session(request)` returns it. */
export interface AuthConsoleSessionUser {
  user: { id: string; email: string };
  /** The administrator who opened this session as `user`, or `null` when the session is not an impersonation. */
  impersonatedBy: { id: string; email: string } | null;
}
export interface AuthConsoleImpersonation {
  /** Seconds until an impersonation session ends. Better Auth's `admin({ impersonationSessionDuration })` sets it. */
  duration: number;
  /** The user that the app session of this request impersonates, or `null`. */
  active: { user: Pick<AuthConsoleUser, "id" | "name" | "email" | "image">; expiresAt: string } | null;
}

export type AuthConsoleEventGroup = "sign-in" | "admin" | "agents" | "organizations";
export const authConsoleEventGroups: Readonly<
  Record<AuthConsoleEventGroup, readonly AuthEventType[]>
> = {
  "sign-in": ["user.signed_up", "user.signed_in", "user.signed_out", "sign_in.failed"],
  admin: [
    "session.revoked",
    "user.banned",
    "user.unbanned",
    "user.role_changed",
    "user.updated",
    "user.removed",
    "impersonation.started",
    "impersonation.stopped",
  ],
  agents: ["oauth.consent_granted", "oauth.consent_revoked"],
  organizations: [
    "organization.member_added",
    "organization.member_removed",
    "organization.member_role_changed",
  ],
};
export interface AuthConsoleActivityQuery {
  group?: keyof typeof authConsoleEventGroups;
  /** The subject user, as in AuthEventListInput. */
  userId?: string;
  cursor?: string;
  limit?: number;
}
export interface AuthConsoleEventUser {
  id: string;
  name: string;
  available: boolean;
}
/** Explicit display projection. Event metadata and provider records stay on the server. */
export interface AuthConsoleEvent {
  id: string;
  type: AuthEventType;
  time: string;
  actor: AuthConsoleEventUser | null;
  subject: AuthConsoleEventUser | null;
}
export interface AuthConsoleActivity {
  enabled: boolean;
  events: AuthConsoleEvent[];
  nextCursor?: string;
}
export interface AuthConsoleOverview {
  users: number | null;
  newUsers: number | null;
  activeSessions: number | null;
  /** Consent grants, one per user and client. Omitted without the OAuth provider plugin. */
  approvedAgents?: number | null;
  activeUsers: number | null;
  window: AuthEventWindow;
  analytics: AuthEventAggregates | null;
  recent: AuthConsoleActivity;
}
export interface AuthConsoleUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  banned: boolean;
  banReason: string | null;
  banExpires: string | null;
  createdAt: string;
  lastActive: string | null;
  providers: string[];
  fields: Record<string, AuthConsoleValue>;
}
export interface AuthConsoleSession {
  id: string;
  user: Pick<AuthConsoleUser, "id" | "name" | "email" | "image">;
  device: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}
/** A user that a host signs in without a password, such as a Console member or an invited guest. */
export interface AuthConsoleHostUserInput {
  /** The email of an existing person. Without it, the user is new and gets a placeholder email. */
  email?: string;
  name: string;
  image?: string;
  /** Roles to add to the comma-separated `user.role` of `admin()`. */
  roles: readonly string[];
}
/** A live session of a user that holds a host role, with the user's roles. */
export interface AuthConsoleHostSession extends AuthConsoleSession {
  roles: string[];
}
export interface AuthConsoleAgent {
  id: string;
  clientId: string;
  name: string;
  user: Pick<AuthConsoleUser, "id" | "name" | "email" | "image">;
  scopes: string[];
  createdAt: string;
  lastUsed: string | null;
}
export interface AuthConsoleOrganization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}
export interface AuthConsoleOrganizationDetail extends AuthConsoleOrganization {
  members: Array<{
    id: string;
    role: string;
    user: Pick<AuthConsoleUser, "id" | "name" | "email" | "image">;
  }>;
  invitations: Array<{ id: string; email: string; role: string; expiresAt: string }>;
  membersTotal: number;
  invitationsTotal: number;
}
export interface AuthConsoleUserDetail {
  user: AuthConsoleUser;
  sessions: AuthConsoleList<AuthConsoleSession>;
  accounts: Array<{ id: string; provider: string; accountId: string; createdAt: string }>;
  agents: AuthConsoleList<AuthConsoleAgent>;
  organizations: Array<AuthConsoleOrganization & { role: string }>;
  accountsTotal: number;
  organizationsTotal: number;
  /** Whether Better Auth accepts this user as an impersonation target. Present only when the host enables impersonation. */
  impersonation?: AuthConsoleCapability;
}
export interface AuthConsoleList<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
export interface AuthConsoleQuery {
  search?: string;
  filter?: "all" | "admins" | "banned" | "agents";
  offset?: number;
  limit?: number;
  userId?: string;
}
export type AuthConsoleMutation =
  | { action: "ban"; userId: string; reason?: string; expiresIn?: number }
  | { action: "unban" | "remove" | "revokeSessions" | "impersonate"; userId: string }
  | { action: "setRole"; userId: string; role: string }
  | { action: "editField"; userId: string; field: string; value: AuthConsoleValue }
  | { action: "revokeSession" | "revokeConsent"; id: string };

export const authConsoleActionNames: readonly AuthConsoleAction[] = [
  "ban",
  "unban",
  "remove",
  "revokeSession",
  "revokeSessions",
  "setRole",
  "editField",
  "impersonate",
  "revokeConsent",
];
