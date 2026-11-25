import { useDatabase } from "vite-hub/database"

import { handleHostedCommentsApi } from "../../../../../src/hosted-comments.ts"

export default { fetch: (request: Request) => handleHostedCommentsApi(request, { db: useDatabase("default").db }) }
