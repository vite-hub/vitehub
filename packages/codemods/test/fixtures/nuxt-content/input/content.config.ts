import { defineCollection, defineContentConfig, z } from '@nuxt/content'
import { authorSchema } from './shared/schemas'

export default defineContentConfig({
  collections: {
    pages: defineCollection({
      type: 'page',
      source: '*.md',
    }),
    blog: defineCollection({
      type: 'page',
      source: { include: 'blog/**/*.md', prefix: '/posts', exclude: ['blog/drafts/**'] },
      schema: z.object({
        date: z.string(),
        tags: z.array(z.string()).optional(),
      }),
    }),
    authors: defineCollection({
      type: 'data',
      source: 'authors/*.yml',
      schema: authorSchema,
    }),
  },
})
