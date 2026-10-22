import { secretCliFeatures } from "@vite-hub/env/cli"

// The CLI entry point needs Node types. The secret features still accept a
// context without Node streams or process.env.
void secretCliFeatures[0]?.run([], { env: {}, stderr: { write() {} }, stdout: { write() {} } })
