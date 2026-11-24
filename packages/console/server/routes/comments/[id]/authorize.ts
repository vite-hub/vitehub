import { withAnonymousAuthorization } from "vite-hub/auth/server"
import { useDatabase } from "vite-hub/database"

import { authorizeHostedComments } from "../../../../src/hosted-comments.ts"

export default {
  fetch: withAnonymousAuthorization(() => true, (request: Request, authorization) =>
    authorizeHostedComments(request, { db: useDatabase("default").db, userId: authorization.user?.id ?? null })),
}
