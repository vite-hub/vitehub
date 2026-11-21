import { resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

it("publishes H3 and Standard Context on callback events without ambient augmentation", () => {
  const entry = resolve(import.meta.dirname, "../published-event-consumer.mts")
  const source = `
import type { RealtimeRequestEvent, RealtimeOriginContext, RealtimeAuthorizeContext } from '@vite-hub/realtime'
import type { H3Event } from 'h3'
declare const event: RealtimeRequestEvent
declare const origin: RealtimeOriginContext
declare const authorization: RealtimeAuthorizeContext
const request: Request = event['~standard'].req
const originRequest: Request = origin.event['~standard'].req
const authorizationRequest: Request = authorization.event['~standard'].req
const h3Event: H3Event = event
`
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    strict: true,
    types: [],
    skipLibCheck: true,
    noEmit: true,
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile
  host.getSourceFile = (fileName, ...args) => fileName === entry
    ? ts.createSourceFile(fileName, source, options.target!, true)
    : getSourceFile(fileName, ...args)
  const program = ts.createProgram([entry], options, host)
  expect(ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), host)).toBe("")
}, 30_000)
