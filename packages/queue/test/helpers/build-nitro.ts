import { build, createNitro, prepare } from "nitro/builder"

const [fixtureDir, preset] = process.argv.slice(2)

const nitro = await createNitro({ rootDir: fixtureDir, preset })
await prepare(nitro)
await build(nitro)
await nitro.close()
