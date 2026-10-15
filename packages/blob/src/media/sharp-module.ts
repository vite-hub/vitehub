// The generated Nitro plugin imports sharp with a literal specifier, so bundlers and file tracers include it, then
// registers it here. A global symbol keeps one registration across duplicated module copies.

/** The part of the sharp API that ViteHub uses. */
export interface SharpLike {
  (input: Uint8Array, options?: Record<string, unknown>): SharpPipelineLike
}

export interface SharpPipelineLike {
  extract(region: { height: number, left: number, top: number, width: number }): SharpPipelineLike
  resize(width: number, height: number, options?: Record<string, unknown>): SharpPipelineLike
  rotate(): SharpPipelineLike
  toBuffer(): Promise<Uint8Array<ArrayBuffer>>
  toFormat(format: string, options?: Record<string, unknown>): SharpPipelineLike
}

const sharpKey = Symbol.for("vitehub.blob.sharp")

/** Returns the sharp function of a module namespace or default export. */
export function sharpFromModule(module: unknown): SharpLike | undefined {
  const candidate: unknown = Object(module) === module ? Reflect.get(Object(module), "default") ?? module : module
  // SAFETY: Only sharp modules reach this function, and sharp's default export is the callable sharp factory.
  return candidate instanceof Function ? candidate as SharpLike : undefined
}

/** Registers the sharp module for image variants. The generated Nitro plugin calls it when sharp is installed. */
export function setBlobSharpModule(module: unknown): void {
  const sharp = sharpFromModule(module)
  if (sharp) Reflect.set(globalThis, sharpKey, sharp)
}

export function getBlobSharpModule(): SharpLike | undefined {
  return sharpFromModule(Reflect.get(globalThis, sharpKey))
}
