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

import { authConsoleActionOperations, authConsoleReadOperations } from "../auth-operations";
import { consoleDateTime } from "./format";
import { projectFetch } from "./project";
import { ConsoleRequestError, requestConsoleOperation } from "./request";

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
async function request(base: string, body: unknown): Promise<unknown> {
  const response = await projectFetch(base, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vitehub-console": "1" },
    body: JSON.stringify(body),
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
/** Reads the Auth section with its `auth.<read>` operation. */
export async function readAuthConsole<K extends keyof AuthResults>(
  operation: K,
  input: { query?: AuthConsoleQuery; activity?: AuthConsoleActivityQuery; id?: string } = {},
  signal?: AbortSignal,
): Promise<AuthResults[K]> {
  const { activity, id, query } = input;
  const value = await requestConsoleOperation(
    authConsoleReadOperations[operation],
    { ...query, ...activity, ...(id === undefined ? {} : { id }) },
    signal ? { signal } : {},
  );
  // The owner and the synthetic fixture share this response contract. Only the selected operation determines its type.
  return value as AuthResults[K];
}
/**
 * Runs one Auth action with its `auth.<action>` operation. Impersonation sets the app session cookie, so it posts to
 * `base`, the Auth management route of the app.
 */
export async function changeAuthConsole(
  base: string,
  input: AuthConsoleMutation | { action: "stopImpersonating" },
): Promise<void> {
  if (input.action === "impersonate" || input.action === "stopImpersonating") {
    await request(base, input);
    return;
  }
  const { action, ...fields } = input;
  await requestConsoleOperation(authConsoleActionOperations[action], fields);
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
