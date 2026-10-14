import { defineDiagnostics } from "nostics";

const docs = "https://vitehub.dev/docs/connections";

const code = (fix: string, page: string) => ({
  why: ({ message }: { message: string }) => message,
  fix,
  docs: `${docs}/${page}`,
});

/**
 * Repair guidance for each code that the management routes return. The error body keeps `code` and
 * `message`, and adds `fix` and `docs` from this catalog.
 */
const managementDiagnostics = /*#__PURE__*/ defineDiagnostics({
  codes: {
    CONNECTION_AUTH_REQUIRED: code(
      "Protect the management routes with Console Auth, or pass an actor function to createConnectionsHandler().",
      "server-api#management-routes",
    ),
    CONNECTION_FORBIDDEN: code(
      "Sign in again. A custom actor function must return user:<id> for an allowed manager.",
      "server-api#management-routes",
    ),
    CONNECTION_INVALID: code("Check the request and the Connection state, then send the request again.", "limits-and-errors#errors"),
    CONNECTION_NOT_FOUND: code("Check the route path and the Vite base.", "server-api#management-routes"),
    CONNECTION_METHOD: code("Send the request with the method in the Allow header.", "server-api#management-routes"),
    CONNECTION_FAILED: code("Try again. If this continues, read the server logs for this request.", "limits-and-errors#errors"),
    CONNECTION_APPROVAL_REQUIRED: code("Approve or deny the pending call in the Connection activity.", "configure#access-rules"),
    CONNECTION_DENIED: code("Change the access rules of the Connection Definition to allow this action.", "configure#access-rules"),
    CONNECTION_EXECUTION_UNKNOWN: code("Check the provider for the result before you send the call again.", "limits-and-errors#errors"),
    CONNECTION_PROVIDER: code("Check the provider status and the account permissions, then try again.", "limits-and-errors#errors"),
    CONNECTION_REAUTH_REQUIRED: code("Reconnect the Connection.", "limits-and-errors#errors"),
  },
});

type ManagementCode = keyof typeof managementDiagnostics;

/** The JSON error of a management route: `code`, `message` (the why), and `fix` and `docs` for known codes. */
export interface ManagementErrorBody {
  code: string;
  docs?: string;
  fix?: string;
  message: string;
  requestId?: string;
}

function isManagementCode(value: string): value is ManagementCode {
  return Object.hasOwn(managementDiagnostics, value);
}

export function managementErrorBody(code: string, message: string, requestId?: string): ManagementErrorBody {
  const body: ManagementErrorBody = { code, message };
  if (isManagementCode(code)) {
    const diagnostic = managementDiagnostics[code]({ message });
    if (diagnostic.fix) body.fix = diagnostic.fix;
    if (diagnostic.docs) body.docs = diagnostic.docs;
  }
  if (requestId) body.requestId = requestId;
  return body;
}
