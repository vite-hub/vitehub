declare module "#vitehub/kv/config" {
  export const hosting: string | undefined
  export const kv: false | import("@vite-hub/kv").ResolvedKVModuleOptions
  const config: { hosting?: string, kv: typeof kv }
  export default config
}
