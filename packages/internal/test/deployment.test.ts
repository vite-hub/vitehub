import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { finalizeDeploymentPlanOutput } from "../src/build/deployment-plan-output.ts"
import {
  assertDeploymentService,
  deploymentPresetFromNitro,
  resolveDeploymentPlan,
} from "../src/deployment.ts"
import { getHostingProvider } from "../src/hosting.ts"
describe("built-in deployment plans", () => {
  it.each([
    ["cloudflare", "cloudflare-module", "cloudflare", "workerd"],
    ["netlify", "netlify", "netlify", "node"],
    ["vercel", "vercel", "vercel", "node"],
    ["deno", "deno-deploy", "deno-deploy", "deno"],
    ["node", "node-server", "self-hosted", "node"],
  ] as const)(
    "resolves %s once into host, runtime, and Nitro output policy",
    (preset, nitroPreset, host, runtime) => {
      expect(resolveDeploymentPlan(preset)).toMatchObject({ host, nitroPreset, preset, runtime })
    },
  )
  it("keeps service guarantees explicit", () => {
    expect(resolveDeploymentPlan("cloudflare").services.queue).toMatchObject({
      adapter: "cloudflare",
      supported: true,
    })
    expect(resolveDeploymentPlan("node").services.rateLimit).toEqual({
      adapter: "memory",
      guarantee: "process-local",
      supported: true,
    })
    expect(() => assertDeploymentService(resolveDeploymentPlan("deno"), "sandbox")).toThrow(
      'The "deno" preset cannot provide sandbox',
    )
  })
  it("keeps legacy hosting detection limited to hosted providers", () => {
    expect(
      ["cloudflare-module", "netlify", "vercel", "deno-deploy", "node-server"].map(
        getHostingProvider,
      ),
    ).toEqual(["cloudflare", "netlify", "vercel", undefined, undefined])
  })
  it("normalizes only the five built-in preset families", () => {
    expect(deploymentPresetFromNitro("cloudflare_module")).toBe("cloudflare")
    expect(deploymentPresetFromNitro("deno-deploy")).toBe("deno")
    expect(deploymentPresetFromNitro("node-server")).toBe("node")
    expect(deploymentPresetFromNitro("bun")).toBeUndefined()
  })
  it("validates and records the whole output contract", async () => {
    for (const preset of ["cloudflare", "netlify", "vercel", "deno", "node"] as const) {
      const rootDir = await mkdtemp(join(tmpdir(), "vitehub-plan-output-"))
      const plan = resolveDeploymentPlan(preset)
      const entry = resolve(rootDir, plan.output.directory, plan.output.entry!)
      await mkdir(dirname(entry), { recursive: true })
      await writeFile(entry, "export {}\n", "utf8")
      await finalizeDeploymentPlanOutput({ plan, rootDir })
      const manifest = JSON.parse(await readFile(resolve(rootDir, plan.output.directory, "deployment.json"), "utf8"))
      expect(manifest).toMatchObject({ host: plan.host, output: plan.output, preset, runtime: plan.runtime, services: plan.services })
    }
  })
  it("validates and records a resolved custom output directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-plan-custom-output-"))
    const outputDir = resolve(rootDir, "custom-output")
    const plan = resolveDeploymentPlan("node")
    const entry = resolve(outputDir, plan.output.entry!)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "export {}\n", "utf8")

    await finalizeDeploymentPlanOutput({ outputDir, plan, rootDir })

    const manifest = JSON.parse(await readFile(resolve(outputDir, "deployment.json"), "utf8"))
    expect(manifest.output).toEqual({ ...plan.output, directory: "custom-output" })
  })
  it("records caller-resolved service metadata", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-plan-services-"))
    const plan = resolveDeploymentPlan("node")
    const entry = resolve(rootDir, plan.output.directory, plan.output.entry!)
    const services = { ...plan.services, blob: { configured: true, supported: true } }
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "export {}\n", "utf8")

    await finalizeDeploymentPlanOutput({ plan, rootDir, services })

    const manifest = JSON.parse(await readFile(resolve(rootDir, plan.output.directory, "deployment.json"), "utf8"))
    expect(manifest.services).toEqual(services)
  })
  it("uses Netlify's deployment root above its Nitro output directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "vitehub-plan-netlify-output-"))
    const outputDir = resolve(rootDir, "custom-netlify", "functions-internal")
    const plan = resolveDeploymentPlan("netlify")
    const entry = resolve(rootDir, "custom-netlify", plan.output.entry!)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "export {}\n", "utf8")

    await finalizeDeploymentPlanOutput({ outputDir, plan, rootDir })

    const manifest = JSON.parse(await readFile(resolve(rootDir, "custom-netlify", "deployment.json"), "utf8"))
    expect(manifest.output.directory).toBe("custom-netlify")
  })
})
