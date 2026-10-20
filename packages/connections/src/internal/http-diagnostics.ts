import { connectionsErrorGuidance } from "../error-diagnostics.ts";

/** The JSON error of a management route: `code`, `message` (the why), and `fix` and `docs` for known codes. */
export interface ManagementErrorBody {
  code: string;
  /** Bounded request facts, such as the expected and received origin. Never credentials. */
  details?: Record<string, string>;
  docs?: string;
  fix?: string;
  message: string;
  requestId?: string;
}

export function managementErrorBody(code: string, message: string, requestId?: string, details?: Record<string, string>): ManagementErrorBody {
  const body: ManagementErrorBody = { code, message };
  if (details) body.details = details;
  const guidance = connectionsErrorGuidance(code);
  if (guidance) {
    body.fix = guidance.fix;
    body.docs = guidance.docs;
  }
  if (requestId) body.requestId = requestId;
  return body;
}
