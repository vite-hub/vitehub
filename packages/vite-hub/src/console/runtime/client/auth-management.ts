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
export async function changeAuthConsole(base: string, input: AuthConsoleMutation): Promise<void> {
  await request(base, input);
}
export const authDate = (value: string | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "Unknown";
export const authFieldValue = (value: unknown) =>
  value === null || value === undefined
    ? "Not set"
    : Array.isArray(value)
      ? value.join(", ")
      : String(value);
