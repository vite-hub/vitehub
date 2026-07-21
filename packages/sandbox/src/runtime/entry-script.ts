export const EXEC_STDIO_OUTPUT_MARKER = '__VITEHUB_OUTPUT__'

export function createEntrySource(definitionPath: string, execution: 'definition' | 'module' = 'definition') {
  const invocation = execution === 'module'
    ? [
        `    const mod = await import(pathToFileURL(${JSON.stringify(definitionPath)}).href)`,
        `    const result = await mod.default`,
      ]
    : [
        `    const raw = await readFile(inputPath, 'utf8')`,
        `    const input = JSON.parse(raw || '{}')`,
        `    const mod = await import(pathToFileURL(${JSON.stringify(definitionPath)}).href)`,
        `    const definition = mod?.default`,
        `    if (!definition || typeof definition.run !== 'function')`,
        `      throw new Error('Sandbox Definition must default-export defineSandbox({ run }).')`,
        `    const result = await definition.run(input.payload, input.context)`,
      ]
  return [
    `import { readFile, writeFile } from 'node:fs/promises'`,
    `import { pathToFileURL } from 'node:url'`,
    ``,
    `function normalizeError(error) {`,
    `  if (error instanceof Error) {`,
    `    return {`,
    `      name: error.name,`,
    `      message: error.message,`,
    `      stack: error.stack,`,
    `      cause: error.cause ? String(error.cause) : undefined,`,
    `    }`,
    `  }`,
    `  return {`,
    `    name: 'Error',`,
    `    message: String(error),`,
    `  }`,
    `}`,
    ``,
    `export async function main(argv = process.argv.slice(2)) {`,
    `  const [inputPath, outputPath] = argv`,
    `  try {`,
    ...invocation,
    `    const output = JSON.stringify({ ok: true, result })`,
    `    await writeFile(outputPath, output)`,
    `    console.log('${EXEC_STDIO_OUTPUT_MARKER}' + output)`,
    `  }`,
    `  catch (error) {`,
    `    const output = JSON.stringify({ ok: false, error: normalizeError(error) })`,
    `    await writeFile(outputPath, output)`,
    `    console.error('${EXEC_STDIO_OUTPUT_MARKER}' + output)`,
    `    process.exitCode = 1`,
    `  }`,
    `}`,
    ``,
    `await main()`,
    ``,
  ].join('\n')
}
