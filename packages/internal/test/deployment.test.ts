import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { finalizeDeploymentPlanOutput } from "../src/build/deployment-plan-output.ts"
import {
  assertDeploymentService,
  hostFromNitroPreset,
  resolveDeploymentPlan,
} from "../src/deployment.ts"
import { getHostingProvider } from "../src/hosting.ts"

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

describe("built-in deployment plans", () => {
  it.each([
    ["cloudflare", "cloudflare-module", "workerd"],
    ["netlify", "netlify", "node"],
    ["vercel", "vercel", "node"],
    ["deno", "deno-deploy", "deno"],
    ["node", "node-server", "node"],
  ] as const)(
    "resolves %s once into host, runtime, and Nitro output policy",
    (host, nitroPreset, runtime) => {
      expect(resolveDeploymentPlan(host)).toMatchObject({ host, nitroPreset, runtime })
    },
  )
  it("keeps service guarantees explicit", () => {
    expect(resolveDeploymentPlan("cloudflare").services.queue).toMatchObject({
      adapter: "cloudflare",
      supported: true,
    })
    expect(resolveDeploymentPlan("node").services.queue).toEqual({
      adapter: "local",
      guarantee: "single-host",
      supported: true,
    })
    expect(resolveDeploymentPlan("node").services.rateLimit).toEqual({
      adapter: "memory",
      guarantee: "process-local",
      supported: true,
    })
    expect(() => assertDeploymentService(resolveDeploymentPlan("deno"), "sandbox")).toThrow(
      'The "deno" host cannot provide sandbox',
    )
  })
  it("says which presets provide Browser and Realtime", () => {
    const presets = ["cloudflare", "deno", "netlify", "node", "vercel"] as const
    expect(Object.fromEntries(presets.map(preset => [preset, resolveDeploymentPlan(preset).services.browser.supported]))).toEqual({
      cloudflare: true, deno: false, netlify: false, node: false, vercel: false,
    })
    expect(Object.fromEntries(presets.map(preset => [preset, resolveDeploymentPlan(preset).services.realtime.supported]))).toEqual({
      cloudflare: true, deno: false, netlify: false, node: true, vercel: false,
    })
  })
  it("keeps legacy hosting detection limited to hosted providers", () => {
    expect(
      ["cloudflare-module", "netlify", "vercel", "deno-deploy", "node-server"].map(
        getHostingProvider,
      ),
    ).toEqual(["cloudflare", "netlify", "vercel", undefined, undefined])
  })
  it("normalizes only the five built-in preset families", () => {
    expect(hostFromNitroPreset("cloudflare_module")).toBe("cloudflare")
    expect(hostFromNitroPreset("deno-deploy")).toBe("deno")
    expect(hostFromNitroPreset("node-server")).toBe("node")
    expect(hostFromNitroPreset("bun")).toBeUndefined()
  })
  it("validates and records the whole output contract", async () => {
    for (const preset of ["cloudflare", "netlify", "vercel", "deno", "node"] as const) {
      const rootDir = await temporaryDirectory("vitehub-plan-output-")
      const plan = resolveDeploymentPlan(preset)
      const entry = resolve(rootDir, plan.output.directory, plan.output.entry!)
      await mkdir(dirname(entry), { recursive: true })
      await writeFile(entry, "export {}\n", "utf8")
      await finalizeDeploymentPlanOutput({ plan, rootDir })
      const manifest = JSON.parse(await readFile(resolve(rootDir, plan.output.directory, "deployment.json"), "utf8"))
      expect(manifest).toMatchObject({ host: preset, output: plan.output, runtime: plan.runtime, services: plan.services })
      expect(manifest).not.toHaveProperty("preset")
      if (preset === "netlify") {
        const wrapper = await readFile(resolve(rootDir, ".netlify", "functions", "server.mjs"), "utf8")
        expect(wrapper).toBe('export { default } from "../functions-internal/server/server.mjs"\n')
        const target = wrapper.match(/from "([^"]+)"/)?.[1]
        expect(target).toBeDefined()
        expect(resolve(rootDir, ".netlify", "functions", target!)).toBe(entry)
      }
    }
  })
  it("validates and records a resolved custom output directory", async () => {
    const rootDir = await temporaryDirectory("vitehub-plan-custom-output-")
    const outputDir = resolve(rootDir, "custom-output")
    const plan = resolveDeploymentPlan("node")
    const entry = resolve(outputDir, plan.output.entry!)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "export {}\n", "utf8")

    await finalizeDeploymentPlanOutput({ outputDir, plan, rootDir })

    const manifest = JSON.parse(await readFile(resolve(outputDir, "deployment.json"), "utf8"))
    expect(manifest.output).toEqual({ ...plan.output, directory: "custom-output" })
  })
  it("records caller-resolved identity and service metadata", async () => {
    const rootDir = await temporaryDirectory("vitehub-plan-services-")
    const plan = resolveDeploymentPlan("node")
    const entry = resolve(rootDir, plan.output.directory, plan.output.entry!)
    const identity = { name: "example-app", source: "package.json" }
    const services = { ...plan.services, blob: { configured: true, supported: true } }
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "export {}\n", "utf8")

    await finalizeDeploymentPlanOutput({ identity, plan, rootDir, services })

    const manifest = JSON.parse(await readFile(resolve(rootDir, plan.output.directory, "deployment.json"), "utf8"))
    expect(manifest.identity).toEqual(identity)
    expect(manifest.services).toEqual(services)
  })
  it("uses Netlify's deployment root above its Nitro output directory", async () => {
    const rootDir = await temporaryDirectory("vitehub-plan-netlify-output-")
    const outputDir = resolve(rootDir, "custom-netlify", "functions-internal")
    const plan = resolveDeploymentPlan("netlify")
    const entry = resolve(rootDir, "custom-netlify", plan.output.entry!)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, "export {}\n", "utf8")

    await finalizeDeploymentPlanOutput({ outputDir, plan, rootDir })

    const manifest = JSON.parse(await readFile(resolve(rootDir, "custom-netlify", "deployment.json"), "utf8"))
    expect(manifest.output.directory).toBe("custom-netlify")
    const wrapper = await readFile(resolve(rootDir, "custom-netlify", "functions", "server.mjs"), "utf8")
    expect(wrapper).toBe('export { default } from "../functions-internal/server/server.mjs"\n')
    const target = wrapper.match(/from "([^"]+)"/)?.[1]
    expect(target).toBeDefined()
    expect(resolve(rootDir, "custom-netlify", "functions", target!)).toBe(resolve(rootDir, "custom-netlify", plan.output.entry!))
  })
  it("follows Nitro's Netlify Frameworks API output without a wrapper", async () => {
    const rootDir = await temporaryDirectory("vitehub-plan-netlify-v1-")
    const outputDir = resolve(rootDir, ".netlify", "v1", "functions")
    const plan = resolveDeploymentPlan("netlify")
    await mkdir(resolve(outputDir, "server"), { recursive: true })
    await writeFile(resolve(outputDir, "server", "server.mjs"), "export {}\n", "utf8")
    const staleWrapper = resolve(rootDir, ".netlify", "functions", "server.mjs")
    await mkdir(dirname(staleWrapper), { recursive: true })
    await writeFile(staleWrapper, 'export { default } from "../functions-internal/server/server.mjs"\n', "utf8")

    await finalizeDeploymentPlanOutput({ outputDir, plan, rootDir })

    const manifest = JSON.parse(await readFile(resolve(rootDir, ".netlify", "deployment.json"), "utf8"))
    expect(manifest.output).toEqual({ ...plan.output, directory: ".netlify", entry: "v1/functions/server/server.mjs" })
    expect(existsSync(staleWrapper)).toBe(false)
  })
  it("keeps a Netlify function that ViteHub did not write", async () => {
    const rootDir = await temporaryDirectory("vitehub-plan-netlify-v1-own-")
    const outputDir = resolve(rootDir, ".netlify", "v1", "functions")
    await mkdir(resolve(outputDir, "server"), { recursive: true })
    await writeFile(resolve(outputDir, "server", "server.mjs"), "export {}\n", "utf8")
    const userFunction = resolve(rootDir, ".netlify", "functions", "server.mjs")
    await mkdir(dirname(userFunction), { recursive: true })
    await writeFile(userFunction, "export default () => new Response()\n", "utf8")

    await finalizeDeploymentPlanOutput({ outputDir, plan: resolveDeploymentPlan("netlify"), rootDir })

    expect(await readFile(userFunction, "utf8")).toBe("export default () => new Response()\n")
  })
})
