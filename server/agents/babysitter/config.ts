import { defineAgent } from '@vite-hub/agent'
import { codexDriver } from '@vite-hub/agent/harness/codex'
import { trustedHost } from '@vite-hub/box'

export default defineAgent({
  box: {
    runtime: trustedHost(),
    cwd: ({ input }) => {
      if (!input.options) throw new Error('Babysitter requires run options.')
      return input.options.worktreePath
    },
    requires: ['git', 'github', 'pnpm'],
  },
  driver: codexDriver<{ worktreePath: string }>(),
})
