import { describe, expect, it } from "vitest"

import type { ViteHubHost } from "../src/deployment.ts"
import { resolveDeploymentPlan } from "../src/deployment.ts"
import type { FeatureId } from "../src/features.ts"
import { featureHosts, featureIds, features, featureSupport, impliedFeatures } from "../src/features.ts"

const presets: ViteHubHost[] = ["cloudflare", "deno", "netlify", "node", "vercel"]

describe("feature catalog", () => {
  it("has one definition per feature id, keyed by its id", () => {
    expect(Object.keys(features).sort()).toEqual([...featureIds].sort())
    for (const id of featureIds) expect(features[id].id).toBe(id)
  })

  it("lists support for every host of every feature", () => {
    for (const id of featureIds) {
      expect(Object.keys(features[id].hosts).sort(), id).toEqual([...featureHosts].sort())
      for (const host of featureHosts) expect(featureSupport(id, host, "node").detail, `${id} on ${host}`).not.toBe("")
    }
  })

  it("matches every Deployment Plan service on every preset", () => {
    for (const preset of presets) {
      const plan = resolveDeploymentPlan(preset)
      for (const id of featureIds) {
        const { service } = features[id]
        if (!service) continue
        const policy = plan.services[service]
        const support = featureSupport(id, preset)
        if (!policy.supported) {
          expect(support.level, `${id} on ${preset}`).not.toBe("native")
          continue
        }
        expect(support, `${id} on ${preset}`).toMatchObject({ adapter: policy.adapter, guarantee: policy.guarantee, level: "native" })
      }
    }
  })

  it("covers every Deployment Plan service", () => {
    const services = Object.keys(resolveDeploymentPlan("cloudflare").services).sort()
    expect(featureIds.flatMap(id => features[id].service ?? []).sort()).toEqual(services)
  })

  it("names an option of the same feature in explicit support", () => {
    for (const id of featureIds) {
      for (const host of featureHosts) {
        const support = featureSupport(id, host, "node")
        if (support.level === "explicit") expect(support.option.startsWith(`${id}.`), `${id} on ${host}`).toBe(true)
      }
    }
  })

  it("implies Workflow from Agent except on Netlify", () => {
    expect(impliedFeatures(["agent"], "cloudflare")).toEqual(["workflow"])
    expect(impliedFeatures(["agent"], "netlify")).toEqual([])
    expect(impliedFeatures(["agent"], "node", ["workflow"])).toEqual([])
  })

  it("requires Database for Comments and Connections but not Console", () => {
    expect(impliedFeatures(["console"], "node")).toEqual([])
    expect(impliedFeatures(["comments"], "node")).toEqual(["database"])
    expect(impliedFeatures(["connections"], "node")).toEqual(["database"])
    expect(impliedFeatures(["connections", "database"], "node")).toEqual([])
  })

  it("only implies features that exist", () => {
    for (const id of featureIds) {
      for (const implication of features[id].implies) expect(featureIds as readonly FeatureId[]).toContain(implication.feature)
    }
  })

  it("turns on only Env by default", () => {
    expect(featureIds.filter(id => features[id].enabledByDefault)).toEqual(["env"])
  })

  it("requires the configured host for development lookups", () => {
    // @ts-expect-error Development needs a host, including when JavaScript calls this API.
    expect(() => featureSupport("workflow", "dev")).toThrow(/configured ViteHub host/)
  })

  it("uses process-local Rate Limit memory during Cloudflare development", () => {
    expect(featureSupport("rateLimit", "dev", "cloudflare")).toMatchObject({
      adapter: "memory",
      guarantee: "process-local",
      level: "native",
    })
    expect(featureSupport("rateLimit", "cloudflare")).toMatchObject({
      adapter: "cloudflare",
      guarantee: "native",
      level: "native",
    })
  })
})
