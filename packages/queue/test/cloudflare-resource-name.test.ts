import { describe, expect, it } from "vitest"

import { getCloudflareQueueName } from "../src/internal/cloudflare-resource-name.ts"

const cloudflareQueueNamePattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

describe("Cloudflare Queue resource names", () => {
  it("keeps valid encoded names unchanged", () => {
    expect(getCloudflareQueueName("welcome")).toBe("queue--77656c636f6d65")
    expect(getCloudflareQueueName("image-optimization", "drop-pm-20260719-")).toBe(
      "drop-pm-20260719-queue--696d6167652d6f7074696d697a6174696f6e",
    )
  })

  it("reuses the legacy Drop Queue when the encoded name exceeds the provider limit", () => {
    const prefix = "vitehub-drop-pm-20260719-"
    const encoded = `${prefix}queue--696d6167652d6f7074696d697a6174696f6e`

    expect(encoded).toHaveLength(68)
    expect(getCloudflareQueueName("image-optimization", prefix)).toBe(
      "vitehub-drop-pm-20260719-image-optimization",
    )
  })

  it("bounds unsafe and long names deterministically without truncation collisions", () => {
    const prefix = `${"deployment".repeat(8)}-`
    const first = getCloudflareQueueName("images/nested/optimization-aaaaaaaa", prefix)
    const repeat = getCloudflareQueueName("images/nested/optimization-aaaaaaaa", prefix)
    const second = getCloudflareQueueName("images/nested/optimization-aaaaaaab", prefix)

    expect(first).toBe("deploymentdeploymentdeployment-f537f0129ff2b8673b34a44f70a00fad")
    expect(first).toBe(repeat)
    expect(first).not.toBe(second)
    for (const name of [first, second]) {
      expect(name.length).toBeLessThanOrEqual(63)
      expect(name).toMatch(cloudflareQueueNamePattern)
    }
  })

  it("hashes the prefix and logical name as separate inputs", () => {
    const left = getCloudflareQueueName("b/c", `${"x".repeat(64)}a-`)
    const right = getCloudflareQueueName("-b/c", `${"x".repeat(64)}a`)

    expect(left).not.toBe(right)
  })

  it.each([
    ["app-", `alpha-${"x".repeat(25)}`, "app-alpha-", "x".repeat(25)],
    ["x".repeat(40), `alpha-${"x".repeat(25)}`, `${"x".repeat(40)}a`, `lpha-${"x".repeat(25)}`],
  ])("does not collide across deployment and logical-name boundaries", (firstPrefix, firstName, secondPrefix, secondName) => {
    const first = getCloudflareQueueName(firstName, firstPrefix)
    const second = getCloudflareQueueName(secondName, secondPrefix)

    expect(first).not.toBe(second)
  })

  it("keeps digest and legacy namespaces disjoint", () => {
    const digestName = getCloudflareQueueName("a".repeat(30), "app-")
    const digestShapedLogicalName = digestName.slice("app-".length)

    expect(digestName).toBe("app-aaaaaaaaaaaaaaaaaaaaaaaaaa-8100e89ec53d2d0d822aabd59f36f5dd")
    expect(getCloudflareQueueName(digestShapedLogicalName, "app-")).not.toBe(digestName)
  })

  it.each([
    ["nested/path", "preview-"],
    ["Ünicode", "preview-"],
    ["QUEUE", `${"x".repeat(63)}-`],
    ["queue--666f6f", `${"x".repeat(50)}-`],
    ["你好".repeat(20), ""],
  ])("derives a portable bounded name for %s", (logicalName, prefix) => {
    const name = getCloudflareQueueName(logicalName, prefix)
    expect(name.length).toBeLessThanOrEqual(63)
    expect(name).toMatch(cloudflareQueueNamePattern)
  })
})
