import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "..")
const consoleSources = [join(repoRoot, "packages/vite-hub/src/console/runtime")]
const baselineFile = join(import.meta.dirname, "fixtures/console-nuxt-ui-ratchet.json")
const update = process.env.VITEHUB_UPDATE_CONSOLE_NUXT_UI_BASELINE === "1"
const updateCommand = "VITEHUB_UPDATE_CONSOLE_NUXT_UI_BASELINE=1 vp test --config vitest.config.ts test/console-nuxt-ui-ratchet.test.ts"

const scriptAndStyle = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g
const nuxtUITag = /<U[A-Z][A-Za-z]*\b/g

function countNuxtUITags(sfc: string): number {
  return sfc.replace(scriptAndStyle, "").match(nuxtUITag)?.length ?? 0
}

function countConsoleFiles(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const dir of consoleSources) {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".vue")) continue
      const file = join(entry.parentPath, entry.name)
      const count = countNuxtUITags(readFileSync(file, "utf8"))
      if (count) counts[relative(repoRoot, file)] = count
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

const current = countConsoleFiles()
if (update) writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`)
const baseline: Record<string, number> = JSON.parse(readFileSync(baselineFile, "utf8"))

function changes(compare: (current: number, baseline: number) => boolean) {
  return [...new Set([...Object.keys(current), ...Object.keys(baseline)])]
    .map(file => ({ file, baseline: baseline[file] ?? 0, current: current[file] ?? 0 }))
    .filter(change => compare(change.current, change.baseline))
}

it("counts Nuxt UI tags in the template only", () => {
  expect(countNuxtUITags([
    `<script setup lang="ts">const columns = ref<UTableColumn[]>([])</script>`,
    `<template><UButton /><div><UTooltip text="x"><UButton label="y" /></UTooltip></div><Uploader /></template>`,
    `<style>.a { --x: "<UButton>" }</style>`,
  ].join("\n"))).toBe(3)
})

it("adds no Nuxt UI tags to Console files", () => {
  expect(changes((now, before) => now > before), [
    "These Console files have more Nuxt UI tags (<U*>) than test/fixtures/console-nuxt-ui-ratchet.json allows.",
    "The Console is moving off Nuxt UI (vite-hub/vitehub#5258).",
    "Build new Console UI with ui-sdk components (@ui-sdk/vue) and @vite-hub/kit parts instead of <U*> components.",
  ].join(" ")).toEqual([])
})

it("keeps the baseline at the current Nuxt UI tag count", () => {
  expect(changes((now, before) => now < before), [
    "These Console files have fewer Nuxt UI tags (<U*>) than test/fixtures/console-nuxt-ui-ratchet.json lists. Good.",
    `Lower the baseline so that the count cannot go back up: ${updateCommand}`,
  ].join(" ")).toEqual([])
})
