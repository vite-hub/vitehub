import { z } from 'zod'

export const authorSchema = z.object({ name: z.string(), avatar: z.string() })
