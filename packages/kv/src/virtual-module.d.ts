declare module "#vitehub/kv/config" {
  export const hosting: string | undefined
  export const kv: false | import("./index.js").ResolvedKVModuleOptions
  /** Loads the databases of the app. Set when a store uses the `database` driver. */
  export const loadDatabases: (() => Promise<Record<string, { db: object } | undefined>>) | undefined
  const config: { hosting?: string, kv: typeof kv }
  export default config
}
