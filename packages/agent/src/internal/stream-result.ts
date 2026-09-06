import { hasRuntimeType } from "./runtime-type.ts"

export type AsyncIterableReadableStream<T> = AsyncIterable<T> & ReadableStream<T>

function hasAsyncIterator(value: unknown): boolean {
  if (!hasRuntimeType(value, "object") || value === null) return false
  try {
    return hasRuntimeType(Reflect.get(value, Symbol.asyncIterator), "function")
  }
  catch {
    return false
  }
}

export function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return hasAsyncIterator(value)
}

function isReadableStream<T>(value: AsyncIterable<T>): value is AsyncIterableReadableStream<T> {
  try {
    return hasRuntimeType(Reflect.get(value, "pipeThrough"), "function")
  }
  catch {
    return false
  }
}

export function withAsyncIterator<T>(stream: ReadableStream<T>): AsyncIterableReadableStream<T> {
  if (hasAsyncIterator(stream)) {
    // SAFETY: A ReadableStream<T> with an async iterator yields the stream's T chunks.
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
  // SAFETY: The installed async iterator reads and yields this ReadableStream<T>'s T chunks.
  return stream as AsyncIterableReadableStream<T>
}

export function toReadableAsyncIterableStream<T>(iterable: AsyncIterable<T>): AsyncIterableReadableStream<T> {
  if (isReadableStream(iterable)) {
    return withAsyncIterator(iterable)
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
  let stream: AsyncIterableReadableStream<T> | undefined
  return {
    configurable: true,
    enumerable: true,
    get() {
      stream ??= toReadableAsyncIterableStream(iterable)
      const [next, branch] = stream.tee()
      stream = withAsyncIterator(next)
      return withAsyncIterator(branch)
    },
  }
}

export function cloneWithPropertyDescriptors<T extends object>(value: T, descriptors: PropertyDescriptorMap): T {
  // SAFETY: The clone retains value's prototype and receives value's complete own property descriptors.
  const clone = Object.create(Object.getPrototypeOf(value)) as T
  // SAFETY: Object.getOwnPropertyDescriptors returns a descriptor for every own PropertyKey of value.
  const ownDescriptors = Object.getOwnPropertyDescriptors(value) as PropertyDescriptorMap & Record<PropertyKey, PropertyDescriptor>
  for (const key of Reflect.ownKeys(descriptors)) {
    delete ownDescriptors[key]
  }
  Object.defineProperties(clone, ownDescriptors)
  Object.defineProperties(clone, descriptors)
  return clone
}
