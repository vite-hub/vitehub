declare module "virtual:@vitehub/blob/config" {
  export const blob: false | import("./index.js").ResolvedBlobModuleOptions
  export const hosting: string | undefined
  const config: { blob: typeof blob, hosting?: string }
  export default config
}
