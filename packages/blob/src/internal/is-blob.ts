export default function isBlob(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) return false
  if (typeof Blob === "undefined") return false

  try {
    // Calling these accessors validates the Blob internal slots, including for
    // Blob and File instances created in another realm. Unlike toString(), the
    // accessors cannot be spoofed with Symbol.toStringTag.
    const blobPrototype = Blob.prototype
    const typeGetter = Object.getOwnPropertyDescriptor(blobPrototype, "type")?.get
    const sizeGetter = Object.getOwnPropertyDescriptor(blobPrototype, "size")?.get
    if (typeof typeGetter !== "function" || typeof sizeGetter !== "function") return false
    typeGetter.call(value)
    sizeGetter.call(value)
    return true
  }
  catch {
    return false
  }
}
