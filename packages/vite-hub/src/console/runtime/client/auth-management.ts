import type {
  AuthConsoleDescription,
  AuthConsoleOverview,
  AuthConsoleActivity,
  AuthConsoleActivityQuery,
  AuthConsoleList,
  AuthConsoleUser,
  AuthConsoleUserDetail,
  AuthConsoleSession,
  AuthConsoleOrganization,
  AuthConsoleOrganizationDetail,
  AuthConsoleAgent,
  AuthConsoleMutation,
  AuthConsoleQuery,
} from "@vite-hub/auth/console";

import { consoleDateTime } from "./time";
import { ConsoleRequestError } from "./request";

type AuthResults = {
  describe: AuthConsoleDescription;
  overview: AuthConsoleOverview;
  activity: AuthConsoleActivity;
  users: AuthConsoleList<AuthConsoleUser>;
  user: AuthConsoleUserDetail;
  sessions: AuthConsoleList<AuthConsoleSession>;
  organizations: AuthConsoleList<AuthConsoleOrganization>;
  organization: AuthConsoleOrganizationDetail;
  agents: AuthConsoleList<AuthConsoleAgent>;
};
async function request(base: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vitehub-console": "1" },
    body: JSON.stringify(body),
    signal,
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new ConsoleRequestError(
      response.status,
      value && typeof value === "object" && "message" in value && typeof value.message === "string"
        ? value.message
        : "Auth request failed.",
    );
  return value;
}
export async function readAuthConsole<K extends keyof AuthResults>(
  base: string,
  operation: K,
  input: { query?: AuthConsoleQuery; activity?: AuthConsoleActivityQuery; id?: string } = {},
  signal?: AbortSignal,
): Promise<AuthResults[K]> {
  // The owner and the synthetic fixture share this response contract. Only the selected operation determines its type.
  return (await request(base, { operation, ...input }, signal)) as AuthResults[K];
}
export async function changeAuthConsole(
  base: string,
  input: AuthConsoleMutation | { action: "stopImpersonating" },
): Promise<void> {
  await request(base, input);
}
export const authDate = (value: string | null) =>
  value
    ? consoleDateTime(value)
    : "Unknown";
export const authFieldValue = (value: unknown) =>
  value === null || value === undefined
    ? "Not set"
    : Array.isArray(value)
      ? value.join(", ")
      : String(value);
/** A session length in words, such as "1 hour" or "1 hour 30 minutes". */
export function authDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (!hours) return unit(rest, "minute");
  return rest ? `${unit(hours, "hour")} ${unit(rest, "minute")}` : unit(hours, "hour");
}
