import { assertKnownPresetOptions, isPresetOptionsRecord, readPresetSelection } from "@vite-hub/internal/presets"

import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { CmsPresetOptions } from "./presets/cms.ts"

const contentPresetMarker: unique symbol = Symbol.for("vitehub.content.preset")

/** Options that a Content preset fills in `defineContent()`. */
export interface ContentPresetDefaults {
  /** Workspace that stores the collections. */
  workspace?: string
}

/**
 * A Content preset selected with `defineContent({ extends: preset })` or `extends: [preset, options]`. A preset fills
 * Definition options at runtime. Infrastructure that it needs, such as a Workspace or Database tables, comes from the
 * Content Vite plugin at build time.
 */
export interface ContentPreset<TOptions extends object = Record<string, unknown>> {
  readonly [contentPresetMarker]: true
  /** Preset name, used in diagnostics. */
  readonly name: string
  /** Default options. Its keys are the options that the tuple form accepts. */
  readonly options: Readonly<TOptions>
  /** Turn resolved options into `defineContent()` defaults. */
  configure(options: TOptions): ContentPresetDefaults
}

/** `extends` in `defineContent()`: a preset, or a preset with options. Options default to the `cms` preset's. */
export type ContentPresetSelection<TOptions extends object = CmsPresetOptions> =
  | ContentPreset<TOptions>
  | readonly [ContentPreset<TOptions>, Partial<TOptions>]

/** Create a Content preset. Internal: the Content Vite plugin recognizes built-in presets by their import path. */
export function defineContentPreset<TOptions extends object>(preset: {
  name: string
  options: TOptions
  configure(options: TOptions): ContentPresetDefaults
}): ContentPreset<TOptions> {
  return Object.freeze({
    [contentPresetMarker]: true as const,
    name: preset.name,
    options: Object.freeze({ ...preset.options }),
    configure: preset.configure,
  })
}

function isContentPreset(value: unknown): value is ContentPreset {
  return value !== null && Object(value) === value && Reflect.get(Object(value), contentPresetMarker) === true
}

/** Resolve `extends` into the Definition defaults that the preset fills. */
export function resolveContentPreset(extension: unknown): ContentPresetDefaults {
  let selection
  try {
    selection = readPresetSelection(extension, "Content")
  }
  catch (error) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: error instanceof Error ? error.message : String(error) })
  }
  const { preset, options } = selection
  if (!isContentPreset(preset)) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: "[vitehub] defineContent({ extends }) requires a Content preset, such as cms from vite-hub/content/presets/cms." })
  }
  if (options) {
    try {
      assertKnownPresetOptions(preset.options, options, `Content ${preset.name} preset`)
    }
    catch (error) {
      throw contentErrorDiagnostics.CONTENT_R0006({ message: error instanceof Error ? error.message : String(error) })
    }
  }
  const merged = { ...preset.options }
  for (const [key, value] of Object.entries(options ?? {})) {
    if (value !== undefined) Reflect.set(merged, key, value)
  }
  const defaults = preset.configure(merged)
  if (!isPresetOptionsRecord(defaults)) {
    throw contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] Content preset ${JSON.stringify(preset.name)} must return an options object from configure().` })
  }
  return defaults
}
