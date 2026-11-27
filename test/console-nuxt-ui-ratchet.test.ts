import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { expect, it } from "vitest"
import { camelize, capitalize } from "vue"
import { parse } from "vue/compiler-sfc"

const repoRoot = resolve(import.meta.dirname, "..")
const consoleSources = [join(repoRoot, "packages/vite-hub/src/console/runtime")]
const baselineFile = join(import.meta.dirname, "fixtures/console-nuxt-ui-ratchet.json")
const update = process.env.VITEHUB_UPDATE_CONSOLE_NUXT_UI_BASELINE === "1"
const updateCommand = "VITEHUB_UPDATE_CONSOLE_NUXT_UI_BASELINE=1 vp test --config vitest.config.ts test/console-nuxt-ui-ratchet.test.ts"

function countNuxtUITags(sfc: string, filename: string): number {
  const { descriptor, errors } = parse(sfc, { filename })
  if (errors.length) throw new Error(`Cannot parse ${filename}: ${errors.join("; ")}`)

  const nodes = [...(descriptor.template?.ast?.children ?? [])]
  let count = 0
  for (const node of nodes) {
    if (!("tag" in node)) continue
    if (/^U[A-Z]/.test(capitalize(camelize(node.tag)))) count++
    nodes.push(...node.children)
  }
  return count
}

function countConsoleFiles(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const dir of consoleSources) {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".vue")) continue
      const file = join(entry.parentPath, entry.name)
      const count = countNuxtUITags(readFileSync(file, "utf8"), file)
      if (count) counts[relative(repoRoot, file)] = count
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

const current = countConsoleFiles()
const baseline: Record<string, number> = JSON.parse(readFileSync(baselineFile, "utf8"))
const changes = [...new Set([...Object.keys(current), ...Object.keys(baseline)])]
  .map(file => ({ file, baseline: baseline[file] ?? 0, current: current[file] ?? 0 }))
const increases = changes.filter(change => change.current > change.baseline)

it("counts Vue component elements in the template only", () => {
  expect(countNuxtUITags([
    `<script setup lang="ts">const columns = ref<UTableColumn[]>([])</script>`,
    `<template>`,
    `<UButton /><div><UTooltip text="x"><u-button label="y" /></UTooltip></div><Uploader />`,
    `<div title="<UButton>" />`,
    `<!-- <u-button /> <UButton /> -->`,
    `</template>`,
    `<style>.a { --x: "<UButton>" }</style>`,
  ].join("\n"), "example.vue")).toBe(3)
})

it("adds no Nuxt UI tags to Console files", () => {
  expect(increases, [
    "These Console files have more Nuxt UI tags (<U*>) than test/fixtures/console-nuxt-ui-ratchet.json allows.",
    "The Console is moving off Nuxt UI (vite-hub/vitehub#5258).",
    "Build new Console UI with ui-sdk components (@ui-sdk/vue) and @vite-hub/kit parts instead of <U*> components.",
  ].join(" ")).toEqual([])
})

it("keeps the baseline at the current Nuxt UI tag count", () => {
  if (update) {
    if (!increases.length) writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`)
    return
  }
  expect(changes.filter(change => change.current < change.baseline), [
    "These Console files have fewer Nuxt UI tags (<U*>) than test/fixtures/console-nuxt-ui-ratchet.json lists. Good.",
    `Lower the baseline so that the count cannot go back up: ${updateCommand}`,
  ].join(" ")).toEqual([])
})
