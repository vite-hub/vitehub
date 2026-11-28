const inViteHub = "in `vitehub()`, or in the `vitehub` key of `nuxt.config.ts`"

/**
 * The operation namespaces of each Console operation module, with the fix that turns its feature on. The RPC reads it to
 * tell a call for a feature that this app does not have from a call that names an operation of another ViteHub version.
 * It lists namespaces, not operation names, so the RPC bundle of an app does not carry the operations it does not serve.
 */
export const consoleFeatureNamespaces = {
  agentConsoleOperations: {
    fix: `Add an Agent Definition, such as \`server/agents/support.ts\`, and set \`agent\` ${inViteHub}.`,
    namespaces: ["agents", "channels", "invocations", "search", "skills", "status"],
  },
  authConsoleOperations: {
    fix: `Add an Auth Definition, such as \`server/auth.ts\`, and set \`auth\` ${inViteHub}.`,
    namespaces: ["auth"],
  },
  databaseConsoleOperations: {
    fix: `Set \`database\` ${inViteHub}.`,
    namespaces: ["databases"],
  },
  documentConsoleOperations: {
    fix: "Add a document editor owner, such as Content: define document collections in `server/content.ts`.",
    namespaces: ["documents"],
  },
  envConsoleOperations: {
    fix: `Remove \`env: false\` ${inViteHub}.`,
    namespaces: ["env"],
  },
  logsConsoleOperations: {
    fix: `Set \`logs\` ${inViteHub}.`,
    namespaces: ["logs"],
  },
  mediaConsoleOperations: {
    fix: `Set \`blob\` ${inViteHub}, and add a document editor owner, such as Content with document collections in \`server/content.ts\`.`,
    namespaces: ["media"],
  },
  siteAccessOperations: {
    fix: `Set \`console\` and turn Comments on ${inViteHub}, or add \`server/comments.ts\`. Site access is off with \`comments: false\` or \`comments: { overlay: false }\`.`,
    namespaces: ["site"],
  },
  workspaceConsoleOperations: {
    fix: `Set \`workspace\` ${inViteHub}.`,
    namespaces: ["workspaces"],
  },
} as const satisfies Record<string, { fix: string, namespaces: readonly string[] }>

const featureFixes = new Map<string, string>(Object.values(consoleFeatureNamespaces).flatMap(({ fix, namespaces }) => namespaces.map(namespace => [namespace, fix] as const)))

/** The fix that turns on the feature that owns the namespace of `name`, or `undefined` when no Console operation module owns it. */
export function consoleFeatureFix(name: string): string | undefined {
  const dot = name.indexOf(".")
  return dot > 0 ? featureFixes.get(name.slice(0, dot)) : undefined
}
