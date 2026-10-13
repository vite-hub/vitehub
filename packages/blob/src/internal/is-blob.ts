export default function isBlob(value: unknown): value is Blob {
  try {
    // Calling these accessors validates the Blob internal slots, including for
    // Blob and File instances created in another realm. Unlike toString(), the
    // accessors cannot be spoofed with Symbol.toStringTag.
    const blobPrototype = globalThis.Blob?.prototype
    if (!blobPrototype) return false
    const typeGetter = Object.getOwnPropertyDescriptor(blobPrototype, "type")?.get
    const sizeGetter = Object.getOwnPropertyDescriptor(blobPrototype, "size")?.get
    if (!typeGetter || !sizeGetter) return false
    typeGetter.call(value)
    sizeGetter.call(value)
    return true
  }
  catch {
    return false
  }
}
