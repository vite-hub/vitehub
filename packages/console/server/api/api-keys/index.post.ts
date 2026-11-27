import { withAuthorization } from "vite-hub/auth/server"

import { createApiKeyFor } from "../../utils/console.ts"

export default {
  fetch: withAuthorization(true, async (request: Request, { session, user }) => createApiKeyFor(user.id, Reflect.get(session, "activeOrganizationId"), await request.json().catch(() => undefined))),
}
