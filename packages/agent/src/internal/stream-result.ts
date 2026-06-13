export type AsyncIterableReadableStream<T> = AsyncIterable<T> & ReadableStream<T>

export function isAsyncIterable<T = unknown>(value: unknown): value is AsyncIterable<T> {
  return !!value
    && typeof value === "object"
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
}

export function withAsyncIterator<T>(stream: ReadableStream<T>): AsyncIterableReadableStream<T> {
  if (typeof (stream as AsyncIterable<T>)[Symbol.asyncIterator] === "function") {
    return stream as AsyncIterableReadableStream<T>
  }

  Object.defineProperty(stream, Symbol.asyncIterator, {
    configurable: true,
    value: async function* () {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) return
          yield value
        }
      }
      finally {
        reader.releaseLock()
      }
    },
  })
  return stream as AsyncIterableReadableStream<T>
}

export function toReadableAsyncIterableStream<T>(iterable: AsyncIterable<T>): AsyncIterableReadableStream<T> {
  if (typeof (iterable as ReadableStream<T>).pipeThrough === "function") {
    return withAsyncIterator(iterable as ReadableStream<T>)
  }

  const iterator = iterable[Symbol.asyncIterator]()
  return withAsyncIterator(new ReadableStream<T>({
    async cancel() {
      await iterator.return?.()
    },
    async pull(controller) {
      try {
        const { done, value } = await iterator.next()
        if (done) {
          controller.close()
        }
        else {
          controller.enqueue(value)
        }
      }
      catch (error) {
        controller.error(error)
      }
    },
  }))
}

export function teeingAsyncIterableStreamDescriptor<T>(iterable: AsyncIterable<T>): PropertyDescriptor {
  let stream = toReadableAsyncIterableStream(iterable)
  return {
    configurable: true,
    enumerable: true,
    get() {
      const [next, branch] = stream.tee()
      stream = withAsyncIterator(next)
      return withAsyncIterator(branch)
    },
  }
}

export function cloneWithPropertyDescriptors<T extends object>(value: T, descriptors: PropertyDescriptorMap): T {
  const clone = Object.create(Object.getPrototypeOf(value)) as T
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value))
  Object.defineProperties(clone, descriptors)
  return clone
}
