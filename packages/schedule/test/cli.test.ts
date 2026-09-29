import { describe, expect, it } from "vitest"

import { parseScheduleRunArgs, runScheduleRunCli } from "../src/cli.ts"

function output() {
  let text = ""
  return { stream: { write: (chunk: string | Uint8Array) => { text += String(chunk) } }, text: () => text }
}

function recordingFetch(response: Response) {
  const requests: Request[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(new Request(input, init))
    return response
  }
  return { fetch: fetchImpl, requests }
}

const succeededRun = {
  completedAt: "2026-09-29T10:00:01.250Z",
  id: "srun_manual_sync_2026-09-29T10:00:00.000Z",
  scheduleId: "sync",
  startedAt: "2026-09-29T10:00:00.000Z",
  status: "succeeded",
}

describe("vitehub schedule run", () => {
  it("parses the name and options", () => {
    expect(parseScheduleRunArgs(["sync", "--url", "https://app.example", "--json"])).toEqual({ help: false, json: true, name: "sync", url: "https://app.example" })
    expect(parseScheduleRunArgs(["--server=http://localhost:3000", "sync"])).toEqual({ help: false, json: false, name: "sync", server: "http://localhost:3000" })
    expect(() => parseScheduleRunArgs(["sync", "cleanup"])).toThrow("Unexpected schedule run argument: cleanup")
    expect(() => parseScheduleRunArgs(["sync", "--url"])).toThrow("--url requires a value.")
    expect(() => parseScheduleRunArgs(["sync", "--force"])).toThrow("Unknown schedule run option: --force")
  })

  it("posts to the Console route with the Console credential", async () => {
    const recording = recordingFetch(Response.json({ run: succeededRun }))
    const stdout = output()

    const code = await runScheduleRunCli(["sync", "--url", "https://app.example/base"], {
      env: { VITEHUB_CONSOLE_AUTHORIZATION: "Bearer console-token", VITEHUB_CONSOLE_COOKIE: "vitehub_console.session_token=abc" },
      stderr: output().stream,
      stdout: stdout.stream,
    }, { fetch: recording.fetch })

    expect(code).toBe(0)
    expect(stdout.text()).toBe("succeeded sync in 1.3 s\nRun srun_manual_sync_2026-09-29T10:00:00.000Z\n")
    const [request] = recording.requests
    expect(request?.url).toBe("https://app.example/base/_vitehub/schedules/run")
    expect(request?.headers.get("authorization")).toBe("Bearer console-token")
    expect(request?.headers.get("cookie")).toBe("vitehub_console.session_token=abc")
    expect(request?.headers.get("x-vitehub-schedule-run")).toBeNull()
    await expect(request?.json()).resolves.toEqual({ name: "sync" })
  })

  it("posts to the Development Server route without a Console credential", async () => {
    const recording = recordingFetch(Response.json({ run: succeededRun }))

    await runScheduleRunCli(["sync"], {
      env: { VITEHUB_CONSOLE_AUTHORIZATION: "Bearer console-token", VITEHUB_DEV_SERVER_URL: "http://localhost:4000" },
      stderr: output().stream,
      stdout: output().stream,
    }, { fetch: recording.fetch })

    const [request] = recording.requests
    expect(request?.url).toBe("http://localhost:4000/__vitehub/schedule/run")
    expect(request?.headers.get("x-vitehub-schedule-run")).toBe("1")
    expect(request?.headers.get("authorization")).toBeNull()
  })

  it("prints JSON and exits with 1 for a failed run", async () => {
    const run = { ...succeededRun, error: { message: "mailbox unavailable" }, status: "failed" }
    const stdout = output()

    const code = await runScheduleRunCli(["sync", "--json", "--url", "https://app.example"], { env: {}, stderr: output().stream, stdout: stdout.stream }, { fetch: recordingFetch(Response.json({ run })).fetch })

    expect(code).toBe(1)
    expect(JSON.parse(stdout.text())).toEqual(run)
  })

  it("explains authentication and URL failures", async () => {
    const unauthorized = output()
    const redirected = output()
    const insecure = output()

    expect(await runScheduleRunCli(["sync", "--url", "https://app.example"], { env: {}, stderr: unauthorized.stream, stdout: output().stream }, { fetch: recordingFetch(new Response("", { status: 401 })).fetch })).toBe(1)
    expect(await runScheduleRunCli(["sync", "--url", "https://app.example"], { env: {}, stderr: redirected.stream, stdout: output().stream }, { fetch: recordingFetch(new Response(null, { headers: { location: "/_vitehub/sign-in" }, status: 302 })).fetch })).toBe(1)
    expect(await runScheduleRunCli(["sync", "--url", "http://app.example"], { env: {}, stderr: insecure.stream, stdout: output().stream })).toBe(1)

    expect(unauthorized.text()).toBe("Console authentication failed with HTTP 401. Set VITEHUB_CONSOLE_AUTHORIZATION or VITEHUB_CONSOLE_COOKIE.\n")
    expect(redirected.text()).toContain("Console authentication failed with HTTP 302.")
    expect(insecure.text()).toBe("--url must use HTTPS, except for localhost.\n")
  })

  it("reports a missing Console run route", async () => {
    const stderr = output()

    const code = await runScheduleRunCli(["sync", "--url", "https://app.example"], { env: {}, stderr: stderr.stream, stdout: output().stream }, {
      fetch: recordingFetch(Response.json({ message: "Schedule runs are not available. Enable console.invoke and set manual: true." }, { status: 404 })).fetch,
    })

    expect(code).toBe(1)
    expect(stderr.text()).toBe("Schedule run failed with HTTP 404: Schedule runs are not available. Enable console.invoke and set manual: true.\n")
  })
})
