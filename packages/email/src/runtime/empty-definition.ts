import type { EmailDefinition } from "../types.ts"

const definition: EmailDefinition | undefined = undefined

export const outboxRuntimeId: string = "disabled"

/** The configured plugin replaces this with templates from every application server directory. */
export const emailPreview: {
  roots: string[]
  templates: Array<{ file: string, name: string, source: string }>
} = { roots: [], templates: [] }

/** The configured plugin replaces this with the Markdown renderer when the application has templates. */
export const renderEmailTemplate: ((source: string, data?: Record<string, unknown>) => Promise<{ html: string, text: string }>) | undefined = undefined

export default definition
