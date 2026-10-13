export default function isBlob(value: unknown): value is Blob {
  try {
    // Calling these accessors validates the Blob internal slots, including for
    // Blob and File instances created in another realm. Unlike toString(), the
    // accessors cannot be spoofed with Symbol.toStringTag.
    const blobPrototype = globalThis.Blob?.prototype
    if (!blobPrototype) return false
    let prototype: object | null = blobPrototype
    const accessors: Array<[(this: unknown) => unknown, (this: unknown) => unknown]> = []
    while (prototype) {
      const typeGetter = Object.getOwnPropertyDescriptor(prototype, "type")?.get
      const sizeGetter = Object.getOwnPropertyDescriptor(prototype, "size")?.get
      if (typeGetter && sizeGetter) accessors.push([typeGetter, sizeGetter])
      prototype = Object.getPrototypeOf(prototype)
    }
    prototype = Object.getPrototypeOf(value as object)
    while (prototype) {
      const typeGetter = Object.getOwnPropertyDescriptor(prototype, "type")?.get
      const sizeGetter = Object.getOwnPropertyDescriptor(prototype, "size")?.get
      if (typeGetter && sizeGetter) accessors.push([typeGetter, sizeGetter])
      prototype = Object.getPrototypeOf(prototype)
    }
    return accessors.some(([typeGetter, sizeGetter]) => {
      try {
        typeGetter.call(value)
        sizeGetter.call(value)
        return true
      }
      catch {
        return false
      }
    })
  }
  catch {
    return false
  }
}
