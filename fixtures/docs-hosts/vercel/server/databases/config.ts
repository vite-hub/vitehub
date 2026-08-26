import { defineDatabase } from '@vite-hub/database'

import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
    databaseName: process.env.CLOUDFLARE_D1_DATABASE_NAME,
    http: true,
  },
  schema: { notes },
})
