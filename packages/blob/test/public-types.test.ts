import { resolve } from "node:path"

import ts from "typescript"
import { expect, it } from "vitest"

it("accepts Fetch Requests, H3 and host Standard Context events from the public Blob entry", () => {
  // Compile only this consumer: the package's other tests import the H3 augmentation themselves.
  const filename = resolve(import.meta.dirname, "blob-consumer.mts")
  const source = `
    import { blob } from "@vite-hub/blob"
    import { H3Event } from "h3"

    const request = new Request("https://example.test/photo.jpg")
    void blob.serve(request, "photo.jpg")
    void blob.store("default", { mode: "read" }).serve(request, "photo.jpg")

    const h3 = new H3Event(new Request("https://example.test/upload"))
    const host = {
      "~standard": { vendor: "test", req: new Request("https://example.test/upload"), res: {} },
      context: { params: { action: "create", pathname: "photo.jpg" } },
    }
    const served: Promise<Response> = blob.serve(h3.req, "photo.jpg")
    void served
    for (const event of [h3, host]) {
      void blob.handleUpload(event)
      void blob.media.handleUpload(event)
      event.context.params = { action: "create", pathname: "photo.jpg" }
      void blob.handleMultipartUpload(event)
    }
  `
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2023,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => file === filename
    ? ts.createSourceFile(file, source, languageVersion, true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([filename], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
  expect(diagnostics).toEqual([])
})
