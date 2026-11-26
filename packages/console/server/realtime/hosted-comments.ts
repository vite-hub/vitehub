import { useDatabase } from "vite-hub/database"

import { hostedCommentsRealtime } from "../../src/hosted-comments.ts"

export default hostedCommentsRealtime(() => useDatabase("default").db)
