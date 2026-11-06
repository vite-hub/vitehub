import { createDecisionsCliNamespace } from "../../../dist/cli.js"

const [feature, ...args] = process.argv.slice(2)
const command = createDecisionsCliNamespace().features.find(item => item.name === feature)
process.exitCode = await command.run(args, {
  cwd: process.cwd(),
  env: process.env,
  rootDir: process.cwd(),
  spawn: async () => ({ exitCode: 0 }),
  stderr: process.stderr,
  stdout: process.stdout,
})
