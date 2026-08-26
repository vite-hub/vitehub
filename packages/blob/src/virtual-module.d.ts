declare module "#vitehub/blob/config" {
  export const hosting: string | undefined
  export const blob: false | import("./index").ResolvedBlobModuleOptions
  const config: { hosting?: string, blob: typeof blob }
  export default config
}
