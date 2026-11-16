import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it } from "vitest"

import { readLocalEnvValues } from "../src/setup/env.ts"

it.each([
  "${BASE.KEY}",
  "${DOLLAR}TOKEN",
  "${UNSET:-${BASE.KEY}}",
  "$LINK",
])("keeps the files of Vite's resolved %s value", async (reference) => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-env-values-"))
  try {
    await writeFile(join(root, ".env"), "BASE.KEY=canary\nTOKEN=canary\n")
    await writeFile(join(root, ".env.production"), `DOLLAR=$\nAPI_KEY=${reference}\n`)
    const values = await readLocalEnvValues(root, root, "production", { LINK: "${DOLLAR}TOKEN" })
    expect(values.get("API_KEY")).toEqual({
      encrypted: false,
      value: "canary",
      source: ".env.production",
      files: expect.arrayContaining([join(root, ".env"), join(root, ".env.production")]),
    })
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
})
