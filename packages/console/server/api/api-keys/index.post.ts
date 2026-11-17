import { withAuthorization } from "vite-hub/auth/server"

import { createApiKeyFor } from "../../utils/console.ts"

// Make an API key: `{ "name": "CI", "teamId": "<team>", "projectIds": ["<project>"], "days": 90 }`. Only `name` is
// required. The answer holds the key once, in `key`.
export default {
  fetch: withAuthorization(true, async (request: Request, { session, user }) => createApiKeyFor(user.id, Reflect.get(session, "activeOrganizationId"), await request.json().catch(() => undefined))),
}
