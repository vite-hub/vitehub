import { describe, expect, it } from "vitest"

import { agentChannelOperations } from "../../agent/src/operations.ts"
import { blobOperations } from "../../blob/src/operations.ts"
import { bundleOperations } from "../../bundle/src/operations.ts"
import { commentsOperations } from "../../comments/src/operations.ts"
import { contentOperations } from "../../content/src/operations.ts"
import { emailOperations } from "../../email/src/operations.ts"
import { envOperations } from "../../env/src/operations.ts"
import { formsOperations } from "../../forms/src/operations.ts"
import { kvOperations } from "../../kv/src/operations.ts"
import { queueOperations } from "../../queue/src/operations.ts"
import { rateLimitOperations } from "../../rate-limit/src/operations.ts"
import { scheduleOperations } from "../../schedule/src/operations.ts"
import { syncOperations } from "../../sync/src/operations.ts"
import { webhooksOperations } from "../../webhooks/src/operations.ts"
import { workflowOperations } from "../../workflow/src/operations.ts"
import { workspaceOperations } from "../../workspace/src/operations.ts"
import { cacheOperations } from "../src/cache/operations.ts"
import { consoleOperationModules } from "../src/console/operation-modules.ts"
import { consoleFeatureFix, consoleFeatureOperations } from "../src/console/runtime/server/feature-operations.ts"
import { consoleOperations } from "../src/console/runtime/server/operations.ts"
import { servedSkillsOperations } from "../src/skills/operations.ts"
import { taskOperations } from "../src/task/operations.ts"

const contributedOperations = {
  agentChannelOperations, blobOperations, bundleOperations, cacheOperations, commentsOperations, contentOperations,
  emailOperations, envOperations, formsOperations, kvOperations, queueOperations, rateLimitOperations, scheduleOperations,
  servedSkillsOperations, syncOperations, taskOperations, webhooksOperations, workflowOperations, workspaceOperations,
}
const operationNames = (operations: Record<string, readonly string[]>) =>
  Object.entries(operations).flatMap(([namespace, names]) => names.map(name => `${namespace}.${name}`))

describe("Console feature operations", () => {
  it.each(consoleOperationModules.map(entry => [entry.export, entry] as const))("lists every Console operation of %s", async (name, entry) => {
    const names = (await entry.load()).map(operation => operation.name)
    expect(operationNames(consoleFeatureOperations[name as keyof typeof consoleFeatureOperations].operations).sort()).toEqual(names.sort())
  })

  it.each(Object.entries(contributedOperations))("lists every plugin operation of %s", (name, operations) => {
    const names = operations.map(operation => operation.name)
    expect(operationNames(consoleFeatureOperations[name as keyof typeof contributedOperations].operations).sort()).toEqual(names.sort())
  })

  it("has no entry without an operation module", () => {
    expect(Object.keys(consoleFeatureOperations).sort()).toEqual([...consoleOperationModules.map(entry => entry.export), ...Object.keys(contributedOperations)].sort())
  })

  it("assigns each optional operation once and excludes operations that every app serves", () => {
    const names = Object.values(consoleFeatureOperations).flatMap(entry => operationNames(entry.operations))
    expect(new Set(names).size).toBe(names.length)
    expect(consoleOperations.map(operation => operation.name).filter(name => consoleFeatureFix(name))).toEqual([])
  })
})
