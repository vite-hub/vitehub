import { hubDatabase } from "file:///home/maxi/.t3/worktrees/vitehub-upgrade-deps/packages/database/src/nuxt.ts"
export default defineNuxtConfig({
  devtools: { enabled: false }, telemetry: false,
  modules: [hubDatabase(), './modules/feedback'],
})
