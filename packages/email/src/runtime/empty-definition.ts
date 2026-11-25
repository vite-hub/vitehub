import type { EmailDefinition, RenderedEmail } from "../types.ts"

const definition: (EmailDefinition & { canSend?: boolean }) | undefined = undefined

export const outboxRuntimeId: string = "disabled"

/** The configured plugin replaces this with templates from every application server directory. */
export const emailPreview: {
  roots: string[]
  templates: Array<{ file: string, name: string, source: string }>
} = { roots: [], templates: [] }

/** The configured plugin replaces this with the template renderer when the application has templates. */
export const renderEmailTemplate: ((source: string, data: Record<string, unknown> | undefined, name: string) => Promise<RenderedEmail>) | undefined = undefined

export default definition
