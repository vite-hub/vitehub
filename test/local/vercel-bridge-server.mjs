#!/usr/bin/env node
import { parseArgs } from "node:util"
import { resolve } from "node:path"

import { createVercelBridge } from "./vercel-bridge.mjs"

const { values } = parseArgs({
  options: { "output-dir": { type: "string" }, port: { type: "string" } },
  strict: true,
})
const outputDir = resolve(values["output-dir"] ?? "playground/vite/.vercel/output")
const port = Number(values.port ?? 8789)

await createVercelBridge({ outputDir, port })
console.log(`[e2e:local] vercel bridge listening on http://127.0.0.1:${port}`)
