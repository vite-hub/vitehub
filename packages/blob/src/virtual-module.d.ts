declare module "#vitehub/blob/config" {
  export const hosting: string | undefined
  export const blob: false | import("@vite-hub/blob").ResolvedBlobModuleOptions
  const config: { hosting?: string, blob: typeof blob }
  export default config
}
