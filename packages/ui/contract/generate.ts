// Writes `contract/api.json`, the API report of every component that `@vite-hub/ui` exports.
//
//   pnpm run contract:api                    (from packages/ui)
//   pnpm run contract:api -- --violations    (also rewrites violations.json)
//
// Run it after a change to a component's props, emits, slots, or rendered `data-*` attributes, and commit the result.
// `test/contract.test.ts` fails while the committed report is stale. Rewrite `violations.json` only to merge it after
// a rebase. A new row in it is a new break of the contract, and the pull request must say why.
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
