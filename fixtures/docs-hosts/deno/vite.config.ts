import { hubAgent } from '@vite-hub/agent/vite'
import { hubKv } from '@vite-hub/kv/vite'
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent({ runtime: 'deno' }),
    hubKv(),
    hubSchedule(),
  ],
  kv: {
    driver: 'deno-kv',
  },
})
