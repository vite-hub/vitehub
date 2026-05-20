const redactedSecret = "<redacted>"
export class SecretEnv<T = string> {
  readonly #value: T

  constructor(value: T) {
    this.#value = value
    Object.freeze(this)
  }

  unseal(): T {
    return this.#value
  }

  toString(): string {
    return redactedSecret
  }

  toJSON(): string {
    return redactedSecret
  }

  [Symbol.toPrimitive](): string {
    return redactedSecret
  }

}

Object.defineProperty(SecretEnv.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value() {
    return redactedSecret
  },
})
