import { describe, expect, it, vi } from "vitest"

import {
  checkResponseResults,
  definitionDefaultExport,
  definitionLocation,
  knownDefinitionNames,
  manualScheduleRun,
  noDestructureNonTuples,
  noModuleScopeDispatch,
  queuePayloadOptions,
  validOutboundChannel,
  validScheduleCron,
  workflowStepNames,
} from "../src/doctor/rules/definitions.ts"
import { codes, doctorTestTimeout, projectCodes } from "./doctor-helpers.ts"

vi.setConfig({ testTimeout: doctorTestTimeout })

const queue = 'import { defineQueue } from "vite-hub/queue"\nexport default defineQueue(async () => {})\n'
const workflow = 'import { defineWorkflow } from "vite-hub/workflow"\nexport default defineWorkflow(async () => {})\n'

describe("vitehub/known-definition-names", () => {
  const definitions = {
    "server/queues/welcome-email.ts": queue,
    "server/workflows/onboard.ts": workflow,
    "server/databases/analytics/config.ts": 'import { defineDatabase } from "vite-hub/database"\nexport default defineDatabase({ dialect: "sqlite" })\n',
  }

  it("reports names that match no discovered Definition", async () => {
    expect(await projectCodes(knownDefinitionNames, {
      ...definitions,
      "server/api/send.post.ts": [
        'import { runQueue, deferQueue } from "vite-hub/queue"',
        'import { runWorkflow } from "@vite-hub/workflow"',
        "export default async () => {",
        '  await runQueue("welcom-email", {})',
        '  deferQueue("digest", {})',
        '  await runWorkflow("onbaord", {})',
        "}",
      ].join("\n"),
    })).toEqual(["VHUB0013", "VHUB0013", "VHUB0013"])
  })

  it("accepts discovered names, dynamic names, and kinds without files", async () => {
    expect(await projectCodes(knownDefinitionNames, {
      ...definitions,
      "server/api/send.post.ts": [
        'import { runQueue } from "vite-hub/queue"',
        'import { runWorkflow } from "vite-hub/workflow"',
        'import { useChannel } from "vite-hub/channels/server"',
        "export default async (name: string) => {",
        '  await runQueue("welcome-email", {})',
        "  await runQueue(name, {})",
        '  await runWorkflow("onboard", {})',
        '  await useChannel("alerts").send("hi", {})',
        "}",
      ].join("\n"),
    })).toEqual([])
  })

  it("accepts the Workflow name of an Agent defined in the same file", async () => {
    expect(await projectCodes(knownDefinitionNames, {
      ...definitions,
      "scripts/smoke.ts": [
        'import { defineAgent, workflow } from "vite-hub/agent"',
        'import { getWorkflowRun } from "vite-hub/workflow"',
        'export const agent = defineAgent({ runtime: workflow("inline-agent") })',
        'export const run = await getWorkflowRun("inline-agent", "run-1")',
      ].join("\n"),
    })).toEqual([])
  })
})

describe("vitehub/definition-default-export", () => {
  it("reports discovered files and workflow steps without a default export", async () => {
    expect(await projectCodes(definitionDefaultExport, {
      "server/queues/welcome-email.ts": queue,
      "server/queues/utils.ts": "export function format() {}\n",
      "server/workflows/onboard/index.ts": workflow,
      "server/workflows/onboard/01.create-user.ts": "export async function createUser() {}\n",
    })).toEqual(["VHUB0014", "VHUB0014"])
  })

  it("accepts default exports and re-exports", async () => {
    expect(await projectCodes(definitionDefaultExport, {
      "server/queues/welcome-email.ts": queue,
      "server/queues/digest.ts": 'export { default } from "../utils/digest-queue"\n',
      "server/utils/digest-queue.ts": queue,
      "server/workflows/onboard/index.ts": workflow,
      "server/workflows/onboard/01.create-user.ts": "export default async function createUser() {}\n",
    })).toEqual([])
  })
})

describe("vitehub/definition-location", () => {
  it("reports Definitions outside the discovered locations", async () => {
    expect(await projectCodes(definitionLocation, {
      "server/queues/welcome-email.ts": queue,
      "server/utils/report.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "0 8 * * *", handler: async () => {} })\n',
      "server/utils/digest.ts": queue,
      "server/lib/triage.agent.ts": 'import { defineAgent } from "vite-hub/agent"\nexport default defineAgent({})\n',
    })).toEqual(["VHUB0015", "VHUB0015", "VHUB0015"])
  })

  it("accepts discovered Definitions and shared base Agents", async () => {
    expect(await projectCodes(definitionLocation, {
      "server/queues/welcome-email.ts": queue,
      "server/schedules/report.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "0 8 * * *", handler: async () => {} })\n',
      "server/agents/support.ts": 'import { defineAgent } from "vite-hub/agent"\nexport default defineAgent({})\n',
      "server/utils/base-agent.ts": 'import { defineAgent } from "vite-hub/agent"\nexport default defineAgent({})\n',
      "server/utils/email-queue.ts": queue,
      "server/queues/email.ts": 'export { default } from "../utils/email-queue"\n',
    })).toEqual([])
  })
})

describe("vitehub/queue-payload-options", () => {
  it("reports enqueue options inside the payload", async () => {
    expect(await codes(queuePayloadOptions, {
      "server/api/a.ts": [
        'import { runQueue, dynamicQueue } from "vite-hub/queue"',
        "export async function send(email: string) {",
        '  await runQueue("welcome-email", { payload: { email }, delaySeconds: 60 })',
        '  dynamicQueue.defer("welcome-email", { payload: { email }, idempotencyKey: email })',
        "}",
      ].join("\n"),
    })).toEqual(["VHUB0016", "VHUB0016"])
  })

  it("accepts options as the third argument and a payload field named payload", async () => {
    expect(await codes(queuePayloadOptions, {
      "server/api/a.ts": [
        'import { runQueue } from "vite-hub/queue"',
        "export async function send(email: string) {",
        '  await runQueue("welcome-email", { email }, { delaySeconds: 60 })',
        '  await runQueue("audit", { payload: { email }, region: "eu" })',
        '  await runQueue("audit", { payload: { email } }, { delaySeconds: 1 })',
        "}",
      ].join("\n"),
    })).toEqual([])
  })
})

describe("vitehub/no-module-scope-dispatch", () => {
  it("reports dispatch calls at module scope", async () => {
    expect(await codes(noModuleScopeDispatch, {
      "server/plugins/warmup.ts": [
        'import { runQueue } from "vite-hub/queue"',
        'import { deferWorkflow } from "vite-hub/workflow"',
        'await runQueue("warmup", {})',
        'deferWorkflow("sync", {})',
      ].join("\n"),
    })).toEqual(["VHUB0017", "VHUB0017"])
  })

  it("accepts dispatch calls in handlers and test files", async () => {
    expect(await codes(noModuleScopeDispatch, {
      "server/api/a.ts": 'import { runQueue } from "vite-hub/queue"\nexport default defineEventHandler(async () => { await runQueue("warmup", {}) })\n',
      "server/queues/a.test.ts": 'import { runQueue } from "vite-hub/queue"\nawait runQueue("warmup", {})\n',
    })).toEqual([])
  })
})

describe("vitehub/no-destructure-non-tuples", () => {
  it("reports tuple destructuring of values and Responses", async () => {
    expect(await codes(noDestructureNonTuples, {
      "server/api/a.ts": [
        'import { runWorkflow } from "vite-hub/workflow"',
        'import { runSandboxTask } from "vite-hub/sandbox/task"',
        "export async function run() {",
        '  const [error, run] = await runWorkflow("onboard", {})',
        '  const [failure, output] = await runSandboxTask("resize", {})',
        "  return { error, run, failure, output }",
        "}",
      ].join("\n"),
    })).toEqual(["VHUB0018", "VHUB0018"])
  })

  it("accepts direct results and the tuple form of runAgent", async () => {
    expect(await codes(noDestructureNonTuples, {
      "server/api/a.ts": [
        'import { runWorkflow } from "vite-hub/workflow"',
        'import { runAgent } from "vite-hub/agent"',
        "export async function run(agent, options) {",
        '  const run = await runWorkflow("onboard", {})',
        '  const [error, answer] = await runAgent(agent, { prompt: "hi" })',
        '  const [failure, text] = await runAgent(agent, { prompt: "hi" }, { output: "drained" })',
        '  const [unknown, value] = await runAgent(agent, { prompt: "hi" }, options)',
        "  return { run, error, answer, failure, text, unknown, value }",
        "}",
      ].join("\n"),
    })).toEqual([])
  })
})

describe("vitehub/check-response-results", () => {
  it("reports data read from a Response", async () => {
    expect(await codes(checkResponseResults, {
      "server/api/a.ts": [
        'import { runSandboxTask } from "vite-hub/sandbox/task"',
        'import { runBrowser } from "vite-hub/browser"',
        "export async function run() {",
        '  const { width } = await runSandboxTask("resize", {})',
        '  const page = await runBrowser("screenshot", {})',
        '  return { width, title: page.title, size: (await runSandboxTask("resize", {})).size }',
        "}",
      ].join("\n"),
    })).toEqual(["VHUB0019", "VHUB0019", "VHUB0019"])
  })

  it("accepts Response members", async () => {
    expect(await codes(checkResponseResults, {
      "server/api/a.ts": [
        'import { runSandboxTask } from "vite-hub/sandbox/task"',
        "export async function run() {",
        '  const response = await runSandboxTask("resize", {})',
        "  if (!response.ok) throw new Error(await response.text())",
        "  const { width } = await response.json()",
        "  return { width, status: response.status }",
        "}",
      ].join("\n"),
    })).toEqual([])
  })
})

describe("vitehub/workflow-step-names", () => {
  const steps = {
    "server/workflows/onboard/01.create-user.ts": "export default async function () {}\n",
    "server/workflows/onboard/02-send-welcome.ts": "export default async function () {}\n",
  }

  it("reports unknown steps and colliding step files", async () => {
    expect(await projectCodes(workflowStepNames, {
      ...steps,
      "server/workflows/onboard/index.ts": 'import { defineWorkflow } from "vite-hub/workflow"\nexport default defineWorkflow(async ({ payload, steps }) => { const user = await steps.createUser(payload); return await steps.sendWelcomeEmail(user) })\n',
    })).toEqual(["VHUB0020"])
    expect(await projectCodes(workflowStepNames, {
      ...steps,
      "server/workflows/onboard/03.create-user.ts": "export default async function () {}\n",
      "server/workflows/onboard/index.ts": 'import { defineWorkflow } from "vite-hub/workflow"\nexport default defineWorkflow(async ({ payload, steps }) => steps.createUser(payload))\n',
    })).toEqual(["VHUB0020"])
  })

  it("accepts steps that match their files", async () => {
    expect(await projectCodes(workflowStepNames, {
      ...steps,
      "server/workflows/onboard/index.ts": [
        'import { defineWorkflow, getWorkflowRun } from "vite-hub/workflow"',
        "export default defineWorkflow(async ({ payload, steps }) => { const user = await steps.createUser(payload); return await steps.sendWelcome(user) })",
        'export async function stepCount(id) { const run = await getWorkflowRun("onboard", id); return run.steps.length }',
      ].join("\n"),
    })).toEqual([])
  })
})

describe("vitehub/valid-schedule-cron", () => {
  it("reports out-of-range values, bad steps, and backwards ranges", async () => {
    expect(await codes(validScheduleCron, {
      "server/schedules/a.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "60 8 * * *", handler: async () => {} })\n',
      "server/schedules/d.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "*/0 5-2 * 13 *", handler: async () => {} })\n',
    })).toEqual(["VHUB0021", "VHUB0021"])
  })

  it("accepts portable cron expressions", async () => {
    expect(await codes(validScheduleCron, {
      "server/schedules/a.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "*/15 0-23 * 1,6 *", handler: async () => {} })\n',
      "server/schedules/b.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule("0 8 * * 1-5", async () => {})\n',
      // The process runtime accepts names and both day fields. Provider builds report them with `SCHEDULE_R0003`.
      "server/schedules/c.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule("0 8 * * MON", async () => {})\n',
      "server/schedules/e.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "0 0 1 * 1", handler: async () => {} })\n',
    })).toEqual([])
  })
})

describe("vitehub/manual-schedule-run", () => {
  const schedules = {
    "server/schedules/report.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "0 8 * * *", handler: async () => {} })\n',
    "server/schedules/backfill.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "0 8 * * *", manual: true, handler: async () => {} })\n',
  }

  it("reports a manual run of a Schedule without manual: true", async () => {
    expect(await projectCodes(manualScheduleRun, {
      ...schedules,
      "server/api/run.post.ts": 'import { runSchedule } from "vite-hub/schedule/runtime"\nexport default defineEventHandler(() => runSchedule("report"))\n',
    })).toEqual(["VHUB0022"])
  })

  it("accepts a manual run of a manual Schedule", async () => {
    expect(await projectCodes(manualScheduleRun, {
      ...schedules,
      "server/api/run.post.ts": 'import { runSchedule } from "vite-hub/schedule/runtime"\nexport default defineEventHandler(() => runSchedule("backfill"))\n',
    })).toEqual([])
  })
})

describe("vitehub/valid-outbound-channel", () => {
  it("reports empty connectors, connectors without send, and an unknown default", async () => {
    expect(await codes(validOutboundChannel, {
      "server/channels/a.ts": 'import { defineOutboundChannel } from "vite-hub/channels"\nexport default defineOutboundChannel({ connectors: {} })\n',
      "server/channels/b.ts": 'import { defineOutboundChannel } from "vite-hub/channels"\nexport default defineOutboundChannel({ connectors: { slack: { url: "x" } }, defaultConnector: "email" })\n',
    })).toEqual(["VHUB0023", "VHUB0023", "VHUB0023"])
  })

  it("accepts configured connectors", async () => {
    expect(await codes(validOutboundChannel, {
      "server/channels/a.ts": 'import { defineOutboundChannel } from "vite-hub/channels"\nimport { slack } from "./slack"\nexport default defineOutboundChannel({ connectors: { slack: slack(), log: { send: async () => ({}) } }, defaultConnector: "log" })\n',
    })).toEqual([])
  })
})

describe("second review regressions", () => {
  it("accepts locally registered Workflows and Schedules run from an explicit registry", async () => {
    expect(await projectCodes(knownDefinitionNames, {
      "server/workflows/onboard.ts": workflow,
      "server/schedules/digest.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: "0 8 * * *", manual: true, handler: async () => {} })\n',
      "server/api/inline.post.ts": [
        'import { createWorkflow, runWorkflow } from "vite-hub/workflow"',
        'import { runSchedule } from "vite-hub/schedule/runtime"',
        'createWorkflow("inline", async () => {})',
        "export default defineEventHandler(async () => {",
        '  await runWorkflow("inline", {})',
        '  await runSchedule("custom", { registry })',
        "})",
      ].join("\n"),
    })).toEqual([])
  })

  it("discovers Definitions in a configured Nuxt server directory", async () => {
    expect(await projectCodes(definitionLocation, {
      "nuxt.config.ts": 'export default defineNuxtConfig({ serverDir: "backend" })\n',
      "backend/queues/welcome.ts": queue,
    }, "nuxt")).toEqual([])
  })

  it("does not read a destructured Workflow Run as the steps argument", async () => {
    expect(await projectCodes(workflowStepNames, {
      "server/workflows/onboard/01.create-user.ts": "export default async function () {}\n",
      "server/workflows/onboard/index.ts": [
        'import { defineWorkflow, getWorkflowRun } from "vite-hub/workflow"',
        "export default defineWorkflow(async ({ payload, steps }) => steps.createUser(payload))",
        'export async function stepNames(id) { const { steps } = await getWorkflowRun("onboard", id); return steps?.map(step => step.name) }',
      ].join("\n"),
    })).toEqual([])
  })

  it("reads static template literals as names", async () => {
    expect(await codes(validScheduleCron, {
      "server/schedules/a.ts": 'import { defineSchedule } from "vite-hub/schedule"\nexport default defineSchedule({ cron: `90 * * * *`, handler: async () => {} })\n',
    })).toEqual(["VHUB0021"])
  })

  it("names the Schedule Run status for runSchedule()", async () => {
    const result = await codes(noDestructureNonTuples, {
      "server/api/run.post.ts": 'import { runSchedule } from "vite-hub/schedule/runtime"\nexport default defineEventHandler(async () => { const [error, run] = await runSchedule("digest") })\n',
    })
    expect(result).toEqual(["VHUB0018"])
  })
})

describe("pullfrog review regressions", () => {
  it("accepts destructured Agent output from runAgent with a Runtime Context", async () => {
    expect(await codes(noDestructureNonTuples, {
      "server/api/ask.post.ts": 'import { runAgent } from "vite-hub/agent"\nexport default defineEventHandler(async (event) => { const [first, second] = await runAgent(agent, ctx, { prompt: "hi" }); return { first, second } })\n',
    })).toEqual([])
  })

  it("reports colliding and empty step names in a folder Workflow without index.ts", async () => {
    expect(await projectCodes(workflowStepNames, {
      "server/workflows/import/01.read.ts": "export default async function () {}\n",
      "server/workflows/import/02-read.ts": "export default async function () {}\n",
      "server/workflows/import/03-.ts": "export default async function () {}\n",
      "server/workflows/import/04.write.ts": "export default async function () {}\n",
    })).toEqual(["VHUB0020", "VHUB0020", "VHUB0020"])
  })
})

describe("third review regressions", () => {
  it("accepts a Workflow registered with the createWorkflow() object form", async () => {
    expect(await projectCodes(knownDefinitionNames, {
      "server/workflows/onboard.ts": workflow,
      "server/api/inline.post.ts": [
        'import { createWorkflow, runWorkflow } from "vite-hub/workflow"',
        'createWorkflow({ name: "inline", handler: async () => {} })',
        'export default defineEventHandler(async () => { await runWorkflow("inline", {}) })',
      ].join("\n"),
    })).toEqual([])
  })
})

describe("TypeScript parameter properties", () => {
  it("binds a constructor parameter property that shadows a ViteHub import", async () => {
    expect(await projectCodes(knownDefinitionNames, {
      "server/queues/welcome.ts": queue,
      "server/utils/mailer.ts": [
        'import { runQueue } from "vite-hub/queue"',
        "export class Mailer {",
        '  constructor(private runQueue: (name: string) => void) { runQueue("local") }',
        "}",
        'export const send = () => runQueue("welcome", {})',
      ].join("\n"),
    })).toEqual([])
  })
})

describe("folder Workflow handler steps", () => {
  it("checks only the steps argument of the Workflow handler", async () => {
    expect(await projectCodes(workflowStepNames, {
      "server/workflows/onboard/01.create-user.ts": "export default async function () {}\n",
      "server/workflows/onboard/index.ts": [
        'import { defineWorkflow } from "vite-hub/workflow"',
        "export function stepNames(run) { return run.steps?.map(step => step.name) }",
        "export function count(steps) { return steps.length }",
        "export default defineWorkflow(async (ctx) => { await ctx.steps.createUser(ctx.payload); return ctx.steps.sendWelcome() })",
      ].join("\n"),
    })).toEqual(["VHUB0020"])
  })
})

describe("Workflow payload data named steps", () => {
  it("does not read payload.steps as the step runner", async () => {
    expect(await projectCodes(workflowStepNames, {
      "server/workflows/onboard/01.create-user.ts": "export default async function () {}\n",
      "server/workflows/onboard/index.ts": [
        'import { defineWorkflow } from "vite-hub/workflow"',
        "export default defineWorkflow(async ({ payload, steps: run }) => { payload.steps.map(x => x); await run.createUser(payload); return run.sendWelcome() })",
      ].join("\n"),
    })).toEqual(["VHUB0020"])
  })
})

