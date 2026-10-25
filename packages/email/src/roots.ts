// The Vite plugin knows the template roots and the Nitro runtime answers `email.preview`. They share one process in
// `vite dev`, so the plugin leaves the roots here.
const rootsKey = Symbol.for("vitehub.email.templateRoots")

type RootsGlobal = typeof globalThis & { [rootsKey]?: readonly string[] }

export function setEmailTemplateRoots(roots: readonly string[]): void {
  ;(globalThis as RootsGlobal)[rootsKey] = [...roots]
}

/** The `server/emails` roots of the running app, or `undefined` before the plugin set them. */
export function getEmailTemplateRoots(): readonly string[] | undefined {
  return (globalThis as RootsGlobal)[rootsKey]
}
