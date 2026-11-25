import { useDatabase } from "vite-hub/database"

import { redeemHostedComments } from "../../../../src/hosted-comments.ts"

export default { fetch: (request: Request) => redeemHostedComments(request, { db: useDatabase("default").db }) }
