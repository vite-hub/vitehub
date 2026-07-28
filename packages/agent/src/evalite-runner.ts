import { mkdir, writeFile } from "node:fs/promises"
import process from "node:process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { agentEvalFileConvention } from "./discovery.ts"

import type { Writable } from "node:stream"
import type { Evalite } from "evalite/types"
import type { ResolvedAgentEvalOptions } from "./internal/evalite-config.ts"

export interface RunAgentEvaliteOptions extends ResolvedAgentEvalOptions {
  cacheEnabled?: boolean
  cwd: string
  include?: string[]
  mode: Evalite.RunMode
  outputPath?: string
  path?: string
  scoreThreshold?: number
  testOutputWritable?: Writable
}

async function exportResultsToJSON(options: { cwd: string, outputPath: string, storage: Evalite.Storage }): Promise<void> {
  const latestFullRunResults = await options.storage.runs.getMany({
    limit: 1,
    orderBy: "created_at",
    orderDirection: "desc",
    runType: "full",
  })
  const latestFullRun = latestFullRunResults[0]
  if (!latestFullRun) {
    throw new Error("No completed run found to export")
  }

  const suites = await options.storage.suites.getMany({
    runIds: [latestFullRun.id],
    statuses: ["fail", "success"],
  })
  const evals = await options.storage.evals.getMany({
    suiteIds: suites.map(suite => suite.id),
  })
  const scores = await options.storage.scores.getMany({
    evalIds: evals.map(item => item.id),
  })
  const traces = await options.storage.traces.getMany({
    evalIds: evals.map(item => item.id),
  })

  const outputData = {
    run: {
      createdAt: latestFullRun.created_at,
      id: latestFullRun.id,
      runType: latestFullRun.runType,
    },
    suites: suites.map((suite) => {
      const suiteEvals = evals.filter(item => item.suite_id === suite.id)
      const suiteScores = scores.filter(score => suiteEvals.some(item => item.id === score.eval_id))
      const suiteAverageScore = suiteScores.length
        ? suiteScores.reduce((total, score) => total + score.score, 0) / suiteScores.length
        : 0

      return {
        averageScore: suiteAverageScore,
        createdAt: suite.created_at,
        duration: suite.duration,
        evals: suiteEvals.map((item) => {
          const itemScores = scores.filter(score => score.eval_id === item.id)
          const itemTraces = traces.filter(trace => trace.eval_id === item.id)
          return {
            averageScore: itemScores.length ? itemScores.reduce((total, score) => total + score.score, 0) / itemScores.length : 0,
            colOrder: item.col_order,
            createdAt: item.created_at,
            duration: item.duration,
            expected: item.expected,
            id: item.id,
            input: item.input,
            output: item.output,
            renderedColumns: item.rendered_columns,
            scores: itemScores.map(score => ({
              createdAt: score.created_at,
              description: score.description,
              id: score.id,
              metadata: score.metadata,
              name: score.name,
              score: score.score,
            })),
            status: item.status,
            traces: itemTraces.map(trace => ({
              colOrder: trace.col_order,
              endTime: trace.end_time,
              id: trace.id,
              input: trace.input,
              inputTokens: trace.input_tokens,
              output: trace.output,
              outputTokens: trace.output_tokens,
              startTime: trace.start_time,
              totalTokens: trace.total_tokens,
            })),
          }
        }),
        filepath: suite.filepath,
        id: suite.id,
        name: suite.name,
        status: suite.status,
        variantGroup: suite.variant_group,
        variantName: suite.variant_name,
      }
    }),
  }

  const outputPath = path.isAbsolute(options.outputPath)
    ? options.outputPath
    : path.join(options.cwd, options.outputPath)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(outputData, null, 2), "utf8")
}

export async function runAgentEvalite(options: RunAgentEvaliteOptions): Promise<{ exitCode?: number }> {
  const [
    { FILES_LOCATION },
    { DEFAULT_SERVER_PORT },
    { default: EvaliteReporter },
    { createServer },
    { createInMemoryStorage },
    { configDefaults },
    { createVitest, registerConsoleShortcuts },
  ] = await Promise.all([
    import("evalite/backend-only-constants"),
    import("evalite/constants"),
    import("evalite/reporter"),
    import("evalite/server"),
    import("evalite/in-memory-storage"),
    import("vitest/config"),
    import("vitest/node"),
  ])

  const cwd = options.cwd
  const filesLocation = path.join(cwd, FILES_LOCATION)
  await mkdir(filesLocation, { recursive: true })

  const storage = createInMemoryStorage()
  const serverPort = options.server?.port ?? DEFAULT_SERVER_PORT
  const server = createServer({ storage })
  server.start(serverPort)

  let exitCode: number | undefined
  const setupFiles = [fileURLToPath(import.meta.resolve("evalite/env-setup-file")), ...(options.setupFiles || [])]
  const forceRerunTriggers = options.forceRerunTriggers ?? configDefaults.forceRerunTriggers

  process.env.EVALITE_REPORT_TRACES = "true"
  type VitestOptions = Parameters<typeof createVitest>[1]
  // Evalite and Vite+ can resolve separate Vitest type instances, but the reporter runtime contract is the same.
  const reporters = [new EvaliteReporter({
    hideTable: options.hideTable,
    isWatching: options.mode === "watch-for-file-changes" || options.mode === "run-once-and-serve",
    logNewState: newState => server.updateState(newState),
    mode: options.mode,
    modifyExitCode: code => {
      exitCode = code
    },
    port: serverPort,
    scoreThreshold: options.scoreThreshold,
    storage,
  })] as unknown as VitestOptions["reporters"]
  const vitest = await createVitest("test", {
    browser: undefined,
    config: false,
    forceRerunTriggers,
    include: options.include ?? agentEvalFileConvention.include,
    maxConcurrency: options.maxConcurrency,
    mode: "test",
    reporters,
    root: cwd,
    sequence: {
      concurrent: true,
    },
    setupFiles,
    testTimeout: options.testTimeout ?? 30_000,
    watch: options.mode === "watch-for-file-changes",
  }, {}, {
    stderr: options.testOutputWritable || process.stderr,
    stdout: options.testOutputWritable || process.stdout,
  })

  const provide = vitest.provide as (key: string, value: unknown) => void
  provide("cwd", cwd)
  provide("trialCount", options.trialCount)
  provide("serverPort", serverPort)
  provide("cacheDebug", false)
  provide("cacheEnabled", options.cacheEnabled ?? options.cache ?? true)

  await vitest.start(options.path ? [options.path] : undefined)
  const disposeConsoleShortcuts = registerConsoleShortcuts(vitest, process.stdin, process.stdout)
  const rerun = async () => {
    await vitest.cancelCurrentRun("keyboard-input")
    const testFiles = vitest.state.getFilepaths()
    const specs = testFiles.flatMap(filepath => vitest.getModuleSpecifications(filepath))
    await vitest.rerunTestSpecifications(specs, true)
  }
  server.setRerunFn(rerun)

  if (!vitest.shouldKeepServer() && options.mode !== "run-once-and-serve") {
    disposeConsoleShortcuts()
    await vitest.close()
    await server.stop()
    if (options.outputPath) {
      await exportResultsToJSON({ cwd, outputPath: options.outputPath, storage })
    }
  }

  return { exitCode }
}
