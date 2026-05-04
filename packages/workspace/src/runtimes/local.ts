import type { ExecOptions, ExecResult } from "../types.ts"

export function execLocal(command: string, args: string[] = [], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    import("node:child_process").then(({ spawn }) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout.on("data", chunk => stdout.push(Buffer.from(chunk)))
      child.stderr.on("data", chunk => stderr.push(Buffer.from(chunk)))
      child.on("error", reject)
      child.on("close", code => resolve({
        command,
        args,
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }))
    }).catch(reject)
  })
}
