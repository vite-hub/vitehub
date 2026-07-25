import { describe, expect, it } from "vitest"

import { hubDb } from "../src/nuxt.ts"

function createNuxt(options: Record<string, unknown>) {
  const hooks: Record<string, ((value: Record<string, unknown>) => Promise<void> | void)[]> = {}
  return {
    hooks,
    nuxt: {
      options,
      hook(name: string, callback: (value: Record<string, unknown>) => Promise<void> | void) {
        hooks[name] ||= []
        hooks[name]!.push(callback)
      },
    },
  }
}

async function callHook(hooks: Record<string, ((value: Record<string, unknown>) => Promise<void> | void)[]>, name: string, value: Record<string, unknown>) {
  for (const callback of hooks[name] || []) {
    await callback(value)
  }
}

describe("Database Nuxt integration", () => {
  it("wires a D1 database resource into Nuxt Content and Wrangler config", async () => {
    const { hooks, nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
      },
      dev: false,
      modules: ["@nuxt/content"],
      nitro: {
        cloudflare: {
          wrangler: {
            d1_databases: [
              {
                binding: "EXISTING",
                database_id: "existing-id",
                database_name: "existing-db",
              },
            ],
          },
        },
      },
      rootDir: "/tmp/vitehub-db-nuxt",
      vite: {
        plugins: [],
      },
    })
    const module = hubDb()

    expect(module.getModuleDependencies(nuxt)).toEqual({
      "@nuxt/content": {
        overrides: {
          database: {
            type: "d1",
            bindingName: "DB",
          },
        },
      },
    })

    await module(undefined, nuxt)

    expect(nuxt.options.content).toEqual({
      database: {
        type: "d1",
        bindingName: "DB",
      },
    })
    expect(nuxt.options.nitro).toMatchObject({
      cloudflare: {
        wrangler: {
          d1_databases: [
            {
              binding: "EXISTING",
              database_id: "existing-id",
              database_name: "existing-db",
            },
            {
              binding: "DB",
              database_id: "content-id",
              database_name: "content-db",
            },
          ],
        },
      },
    })
    expect(nuxt.options.vite).toMatchObject({
      plugins: [
        expect.objectContaining({ name: "@vite-hub/database/vite" }),
      ],
    })

    const nitroConfig = {
      cloudflare: {
        wrangler: {},
      },
      runtimeConfig: {
        content: {},
      },
    }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig).toEqual({
      cloudflare: {
        wrangler: {
          d1_databases: [
            {
              binding: "DB",
              database_id: "content-id",
              database_name: "content-db",
            },
          ],
        },
      },
      runtimeConfig: {
        content: {
          database: {
            type: "d1",
            bindingName: "DB",
          },
        },
      },
    })
  })

  it("uses local sqlite for Nuxt Content during dev without changing the D1 provider binding", async () => {
    const { nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
        local: {
          filename: ".data/custom-content.sqlite",
        },
      },
      dev: true,
      modules: ["@nuxt/content"],
      rootDir: "/tmp/vitehub-db-nuxt-dev",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options.content).toEqual({
      database: {
        type: "sqlite",
        filename: ".data/custom-content.sqlite",
      },
    })
    expect(nuxt.options.nitro).toMatchObject({
      cloudflare: {
        wrangler: {
          d1_databases: [
            {
              binding: "DB",
              database_id: "content-id",
              database_name: "content-db",
            },
          ],
        },
      },
    })
  })

  it("deduplicates D1 bindings already merged into Nuxt and Nitro config", async () => {
    const binding = {
      binding: "DB",
      database_id: "content-id",
      database_name: "content-db",
    }
    const { hooks, nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
      },
      dev: false,
      nitro: {
        cloudflare: {
          wrangler: {
            d1_databases: [binding, binding],
          },
        },
      },
      rootDir: "/tmp/vitehub-db-nuxt-deduplicated",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options.nitro).toMatchObject({
      cloudflare: {
        wrangler: {
          d1_databases: [binding],
        },
      },
    })

    const nitroConfig = {
      cloudflare: {
        wrangler: {
          d1_databases: [binding, binding],
        },
      },
    }
    await callHook(hooks, "nitro:config", nitroConfig)

    expect(nitroConfig.cloudflare.wrangler.d1_databases).toEqual([binding])
  })

  it("does not emit an invalid Wrangler D1 binding when the resource is incomplete", async () => {
    const { nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseName: "content-db",
      },
      dev: false,
      modules: ["@nuxt/content"],
      rootDir: "/tmp/vitehub-db-nuxt-unresolved",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options.content).toEqual({
      database: {
        type: "d1",
        bindingName: "DB",
      },
    })
    expect(nuxt.options.nitro).toBeUndefined()
  })

  it("keeps an existing database Vite plugin", async () => {
    const existingPlugin = { name: "@vite-hub/database/vite" }
    const { nuxt } = createNuxt({
      database: {
        driver: "d1",
        databaseId: "content-id",
        databaseName: "content-db",
      },
      rootDir: "/tmp/vitehub-db-nuxt-existing-plugin",
      vite: {
        plugins: [existingPlugin],
      },
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options.vite).toMatchObject({
      plugins: [existingPlugin],
    })
  })

  it("can be disabled from top-level Nuxt database config", async () => {
    const { nuxt } = createNuxt({
      database: false,
      rootDir: "/tmp/vitehub-db-nuxt-disabled",
      vite: {},
    })

    await hubDb()(undefined, nuxt)

    expect(nuxt.options).toEqual({
      database: false,
      rootDir: "/tmp/vitehub-db-nuxt-disabled",
      vite: {},
    })
  })
})
