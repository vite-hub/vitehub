import { createStorage } from "unstorage"
import memoryDriver from "unstorage/drivers/memory"
import { describe, expect, it } from "vitest"

import { unstorage } from "../src/unstorage.ts"

describe("unstorage Source", () => {
  it("reads string and structured values from a prefixed driver", async () => {
    const driver = memoryDriver()
    const storage = createStorage({ driver })
    await storage.setItem("docs:guide.md", "# Guide")
    await storage.setItem("docs:guides:start.md", "# Start")
    await storage.setItem("docs:settings.json", { theme: "dark" })
    await storage.setItem("private:secret.txt", "secret")
    const source = unstorage({ driver, prefix: "docs" })
    const ctx = { rootDir: process.cwd() }

    await expect(source.getKeys(ctx)).resolves.toEqual(["guide.md", "guides/start.md", "settings.json"])
    await expect(source.getItem("guide.md", ctx)).resolves.toMatchObject({
      content: "# Guide",
      key: "guide.md",
    })
    await expect(source.getItem("settings.json", ctx)).resolves.toMatchObject({
      content: '{"theme":"dark"}',
      data: { theme: "dark" },
    })
    await expect(source.getItem("guides/start.md", ctx)).resolves.toMatchObject({
      content: "# Start",
      key: "guides/start.md",
    })
  })

  it("reports missing keys without inventing content", async () => {
    const source = unstorage({ driver: memoryDriver() })
    await expect(source.getItem("missing", { rootDir: process.cwd() })).rejects.toThrow("could not find")
  })
})
