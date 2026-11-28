#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

const root = resolve(import.meta.dirname, "../..")
const { values } = parseArgs({
  allowPositionals: false,
  args: process.argv.slice(2).filter(arg => arg !== "--"),
  options: {
    "mode": { default: "dev", type: "string" },
    "no-gates": { default: false, type: "boolean" },
    "port": { type: "string" },
    "template": { type: "string" },
    "url": { type: "string" },
  },
})

const mode = values.url ? "url" : values.mode
if (mode === "url" && !values.template) throw new Error("--url needs --template, because one deployment serves one template.")

const vp = resolve(root, "node_modules/.bin/vp")
if (mode !== "url") {
  for (const target of ["vite-hub#build", "@vite-hub/kit#build"]) {
    const build = spawnSync(vp, ["run", "--cache", "-t", target], { cwd: root, stdio: "inherit" })
    if (build.status !== 0) process.exit(build.status ?? 1)
  }
}

const files = ["test/templates/coverage.test.ts", ...values["no-gates"] || mode === "url" ? [] : ["test/templates/gates.test.ts"], "test/templates/smoke.test.ts"]
const result = spawnSync(vp, ["test", "run", "--config", "test/templates/vitest.config.ts", ...files], {
  cwd: root,
  env: {
    ...process.env,
    LC_ALL: "C",
    VITEHUB_TEMPLATE: values.template ?? "",
    VITEHUB_TEMPLATE_MODE: mode,
    VITEHUB_TEMPLATE_PORT: values.port ?? "",
    VITEHUB_TEMPLATE_URL: values.url ?? "",
  },
  stdio: "inherit",
})
process.exit(result.status ?? 1)
