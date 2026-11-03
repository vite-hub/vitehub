import type { EmailDefinition } from "../types.ts"

const definition: EmailDefinition | undefined = undefined

export const outboxRuntimeId: string = "disabled"

/** The configured plugin replaces this with templates from every application server directory. */
export const emailPreview: {
  roots: string[]
  templates: Array<{ file: string, name: string, source: string }>
} = { roots: [], templates: [] }

export default definition
