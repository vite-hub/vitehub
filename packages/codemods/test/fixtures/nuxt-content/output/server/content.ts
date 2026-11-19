import { contentSource, defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source'
import { z } from 'zod'
import { authorSchema } from '../shared/schemas'

export default defineContent({
  // Nuxt Content served every collection to every visitor.
  access: 'public',
  sources: {
    pages: glob({ cwd: 'content', include: '*.md' }),
    blog: contentSource(glob({ cwd: 'content/blog', include: '**/*.md', prefix: 'posts', ignore: ['drafts/**'] }), { schema: z.object({
      date: z.string(),
      tags: z.array(z.string()).optional(),
    }) }),
    authors: contentSource(glob({ cwd: 'content', include: 'authors/*.yml' }), { schema: authorSchema }),
  },
})
