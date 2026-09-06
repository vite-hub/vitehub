export interface BoundedTextAccumulator {
  append: (text: string) => void
  value: () => string
}

export function createBoundedTextAccumulator(limit: number): BoundedTextAccumulator {
  let retained = ""
  return {
    append(text) {
      retained = `${retained}${text}`.slice(-limit)
    },
    value() {
      return retained
    },
  }
}
