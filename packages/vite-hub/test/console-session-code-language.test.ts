import { describe, expect, it } from "vitest"

import { languageForPath } from "../src/console/runtime/components/console-session-code-language.ts"

describe("Console workspace syntax language", () => {
  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("falls back for prototype-named extension %s", (extension) => {
    expect(languageForPath(`file.${extension}`)).toBe("text")
  })

  it.each([["file.ts", "typescript"], ["file.json", "json"], ["Dockerfile", "dockerfile"]] as const)("keeps known language mapping %s", (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })
})
