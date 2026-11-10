/// <reference types="node" />
/// <reference path="./bun-sqlite.d.ts" />

export {}

declare global {
  interface Timer {
    ref(): Timer
    unref(): Timer
    hasRef(): boolean
    refresh(): Timer
    [Symbol.toPrimitive](): number
  }
}

declare module "#app" {
  export function tryUseNuxtApp(): unknown
}
