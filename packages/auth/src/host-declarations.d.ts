/// <reference types="node" />

import "bun-types/sqlite.d.ts"

declare global {
  interface Timer extends NodeJS.Timer {}
}
