declare module "virtual:@vitehub/blob/config" {
  export const hosting: string | undefined
  export const blob: false | import("./index.js").ResolvedBlobModuleOptions
  const config: { hosting?: string, blob: typeof blob }
  export default config
}
