import { describe, expect, it } from "vitest"

import { normalizeWorkflowOptions } from "../src/config.ts"
import { workflowDeploymentEnv } from "../src/deployment-env.ts"
import { hubWorkflow } from "../src/vite.ts"

const owners = ["workflow"]
const namespace = { names: ["OPENWORKFLOW_NAMESPACE_ID"], required: false, secret: false, hasDefault: true, owners }
const schema = { names: ["OPENWORKFLOW_SCHEMA"], required: false, secret: false, hasDefault: true, owners }

describe("workflowDeploymentEnv", () => {
  it("requires the Postgres URL variable that the config reads, never its value", () => {
    const canary = "postgres://canary-value-7c1e@db.example.com/app"
    const url = { kind: "env-variable" as const, source: { kind: "env" as const, name: "WORKFLOW_DATABASE_URL", names: ["WORKFLOW_DATABASE_URL", "DATABASE_URL"] } }
    const entries = workflowDeploymentEnv(normalizeWorkflowOptions({ driver: "openworkflow", postgres: { url, schema: "jobs" } }, { hosting: "node" }))
    expect(entries).toEqual([
      { names: ["WORKFLOW_DATABASE_URL", "DATABASE_URL"], required: true, secret: true, hasDefault: false, owners },
      namespace,
    ])
    expect(JSON.stringify(entries)).not.toContain(canary)
  })

  it("names the optional storage variables when the config sets no storage", () => {
    expect(workflowDeploymentEnv(normalizeWorkflowOptions({ driver: "openworkflow" }, { hosting: "node" }))).toEqual([
      { names: ["OPENWORKFLOW_SQLITE_PATH"], required: false, secret: false, hasDefault: true, owners },
      { names: ["OPENWORKFLOW_POSTGRES_URL", "DATABASE_URL"], required: false, secret: true, hasDefault: true, owners },
      namespace,
      schema,
    ])
  })

  it("reads no variable for a literal SQLite path with its own namespace", () => {
    expect(workflowDeploymentEnv(normalizeWorkflowOptions({ driver: "openworkflow", sqlite: { path: ".data/wf.db", namespaceId: "app" } }, { hosting: "node" }))).toEqual([])
  })

  it("names nothing for Cloudflare Workflows and Vercel Workflow", () => {
    expect(workflowDeploymentEnv(normalizeWorkflowOptions(undefined, { hosting: "cloudflare-module" }))).toEqual([])
    expect(workflowDeploymentEnv(normalizeWorkflowOptions(undefined, { hosting: "vercel" }))).toEqual([])
    expect(hubWorkflow({}, { hosting: "vercel" }).api.deploymentEnv({ host: "vercel" })).toEqual([])
    expect(hubWorkflow({ driver: "openworkflow" }, { hosting: "node-server" }).api.deploymentEnv({ host: "node" })[0]).toMatchObject({ names: ["OPENWORKFLOW_SQLITE_PATH"] })
  })
})
