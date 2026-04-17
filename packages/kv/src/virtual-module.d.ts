declare module "virtual:@vitehub/kv/config" {
  export const hosting: string | undefined
  export const kv: false | import("./index.js").ResolvedKVModuleOptions
  const config: { hosting?: string, kv: typeof kv }
  export default config
}
