import { defineDatabase } from '@vite-hub/database'
import { notes } from './schema'

export default defineDatabase({
  cloudflare: {
    binding: 'DB',
    databaseName: 'app',
  },
  schema: { notes },
})
