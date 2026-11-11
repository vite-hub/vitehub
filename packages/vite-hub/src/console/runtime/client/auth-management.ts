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

import { authConsoleActionOperations, authConsoleImpersonationOperations, authConsoleReadOperations } from "../auth-operations";
import { consoleDateTime } from "./format";
import { requestConsoleOperation } from "./request";
import { openConsoleTicket } from "./ticket";

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
 * Runs one Auth action with its `auth.<action>` operation. Impersonation sets the app session cookie, so its operation
 * returns a one-time link, and a new tab opens it on the app origin.
 */
export async function changeAuthConsole(input: AuthConsoleMutation | { action: "stopImpersonating" }): Promise<void> {
  if (input.action === "impersonate") return await openConsoleTicket(() => requestConsoleOperation(authConsoleImpersonationOperations.start, { userId: input.userId }));
  if (input.action === "stopImpersonating") return await openConsoleTicket(() => requestConsoleOperation(authConsoleImpersonationOperations.stop, {}));
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
