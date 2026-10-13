import { defineDatabase } from 'vite-hub/database'
import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    binding: 'DB',
    databaseId: '00000000-0000-0000-0000-000000000001',
    databaseName: 'app',
  },
  schema: { notes },
})
