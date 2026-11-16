/**
 * The registry line that rejects a contributed Workspace module without its definition export. It is source text of the
 * generated registry module, which runs in the app and does not import the Workspace catalog.
 */
export function missingDefinitionExportCheck(message: string): string {
  return `    if (!definition) throw new TypeError(${JSON.stringify(message)})`
}
