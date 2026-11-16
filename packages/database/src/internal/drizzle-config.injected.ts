/**
 * Source text of the generated `drizzle.config.ts` for a project with more than one Database. Drizzle Kit runs this
 * text without ViteHub imports, so its error is plain.
 */
export function renderManyDatabasesDrizzleConfig(configs: string): string {
  return `throw new Error(${JSON.stringify(`[vitehub] This project has more than one Database. Run drizzle-kit once per Database with ${configs}, or run \`vitehub database generate\` and \`vitehub database migrate\`.`)})\n`
}
