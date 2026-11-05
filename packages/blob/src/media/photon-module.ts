// The generated Nitro plugin registers a loader with a literal `import('@cf-wasm/photon')`, so bundlers include
// Photon and its WebAssembly module, and the module loads on the first variant instead of at startup.

/** The part of the `@cf-wasm/photon` API that ViteHub uses. */
export interface PhotonLike {
  PhotonImage: {
    new (rgba: Uint8Array, width: number, height: number): PhotonImageLike
    new_from_byteslice(bytes: Uint8Array): PhotonImageLike
  }
  crop(image: PhotonImageLike, x1: number, y1: number, x2: number, y2: number): PhotonImageLike
  resize(image: PhotonImageLike, width: number, height: number, filter: number): PhotonImageLike
}

export interface PhotonImageLike {
  free(): void
  get_bytes(): Uint8Array<ArrayBuffer>
  get_bytes_jpeg(quality: number): Uint8Array<ArrayBuffer>
  get_bytes_webp(): Uint8Array<ArrayBuffer>
  get_height(): number
  get_raw_pixels(): Uint8Array<ArrayBuffer>
  get_width(): number
}

const photonKey = Symbol.for("vitehub.blob.photon")

/** Returns the Photon API of a module namespace. */
export function photonFromModule(module: unknown): PhotonLike | undefined {
  if (Object(module) !== module) return undefined
  const image: unknown = Reflect.get(Object(module), "PhotonImage")
  const resize: unknown = Reflect.get(Object(module), "resize")
  // SAFETY: Only Photon modules reach this function, and these two exports identify its API.
  return image instanceof Function && resize instanceof Function ? module as PhotonLike : undefined
}

/** Registers how to load `@cf-wasm/photon`. The generated Nitro plugin calls it for the `photon` transformer. */
export function setBlobPhotonLoader(load: () => Promise<unknown>): void {
  Reflect.set(globalThis, photonKey, load)
}

export function getBlobPhotonLoader(): (() => Promise<unknown>) | undefined {
  const load: unknown = Reflect.get(globalThis, photonKey)
  // SAFETY: Only `setBlobPhotonLoader()` writes this global symbol.
  return load instanceof Function ? load as () => Promise<unknown> : undefined
}
