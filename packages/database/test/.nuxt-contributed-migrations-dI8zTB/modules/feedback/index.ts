import { createResolver, defineNuxtModule } from 'nuxt/kit'
export default defineNuxtModule({
  meta: { name: 'feedback' },
  setup(_options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    nuxt.options.vite.plugins ||= []
    nuxt.options.vite.plugins.push({
      name: 'feedback/vite',
      vitehub: {
        databases: () => [
          { name: 'feedback', definition: { module: resolve('./schema.ts'), export: 'feedbackSchema' }, reason: 'Stores feedback.' },
          { name: 'votes', migrations: resolve('./migrations'), reason: 'Stores votes with its own SQL.' },
        ],
      },
    })
  },
})
