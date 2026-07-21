import { readFile } from "node:fs/promises"

export interface SandboxPayload {
  queued?: boolean
}

const inputFile = process.argv[2]
if (!inputFile) throw new Error("Sandbox input file is required.")

const { payload } = JSON.parse(await readFile(inputFile, "utf8")) as {
  payload?: SandboxPayload
}

export default { optimized: payload?.queued === true }
