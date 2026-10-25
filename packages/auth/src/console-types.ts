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

/** Host-independent display and edit policy. It does not grant Better Auth permissions. */
export interface AuthConsoleOptions {
  access?: readonly string[];
  actions?: Partial<Record<AuthConsoleAction, AuthConsolePolicy>>;
  columns?: Readonly<Record<string, AuthConsoleColumn>>;
  fields?: Readonly<Record<string, AuthConsoleFieldPolicy | undefined>>;
  roles?: AuthConsolePolicy;
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
