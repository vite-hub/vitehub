/** One row of ConsolePropertyList. ConsoleValue shows `value`; `mono` sets identifiers such as paths in Geist Mono. */
export interface ConsoleProperty {
  label: string
  mono?: boolean
  value: string
}

/** One cell of ConsoleStatGrid. `hint` is a short line under the value, such as "of 12 sessions". */
export interface ConsoleStat {
  hint?: string
  label: string
  value: number | string
}
