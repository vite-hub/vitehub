import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { buildReport, serializeReport } from "./report.ts"
import { contractViolations } from "./rules.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "")
const report = buildReport(packageRoot)
writeFileSync(new URL("api.json", import.meta.url), serializeReport(report))
console.log(`contract/api.json: ${report.components.length} components`)

if (process.argv.includes("--violations")) {
  const violations = contractViolations(report)
  writeFileSync(new URL("violations.json", import.meta.url), `${JSON.stringify(violations, null, 2)}\n`)
  console.log(`contract/violations.json: ${violations.length} violations`)
}
