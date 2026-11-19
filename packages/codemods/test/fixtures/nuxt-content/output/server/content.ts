import { contentSource, defineContent } from 'vite-hub/content'
import { glob } from 'vite-hub/source'
import { z } from 'zod'
import { authorSchema } from '../shared/schemas'

export default defineContent({
  // Nuxt Content served every collection to every visitor.
  access: 'public',
  sources: {
    pages: glob({ cwd: 'content', include: '*.md', ignore: ['**/.DS_Store', '**/*.tmp', '**/*.tmp.*', '**/*~', '**/.#*', '**/~*'] }),
    blog: contentSource(glob({ cwd: 'content/blog', include: '**/*.md', prefix: 'posts', ignore: ['drafts/**', '**/.DS_Store', '**/*.tmp', '**/*.tmp.*', '**/*~', '**/.#*', '**/~*'] }), { schema: z.object({
      date: z.string(),
      tags: z.array(z.string()).optional(),
    }) }),
    authors: contentSource(glob({ cwd: 'content', include: 'authors/*.yml', ignore: ['**/.DS_Store', '**/*.tmp', '**/*.tmp.*', '**/*~', '**/.#*', '**/~*'] }), { schema: authorSchema }),
  },
})
