/// <reference types="node" />

import "bun-types/sqlite.d.ts"

declare global {
  interface Timer {
    ref(): Timer
    unref(): Timer
    hasRef(): boolean
    refresh(): Timer
    [Symbol.toPrimitive](): number
  }
}
