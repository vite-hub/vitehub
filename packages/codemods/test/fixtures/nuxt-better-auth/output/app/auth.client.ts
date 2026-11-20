import { defineAuthClient } from 'vite-hub/auth/vue'
import { adminClient } from 'better-auth/client/plugins'

export default defineAuthClient({
  plugins: [adminClient()],
})
