import { defineDatabase } from 'vite-hub/database'
import * as schema from './schema'

export default defineDatabase({
  schema,
})
