import { featureIds, features, featureSupport, impliedFeatures } from "@vite-hub/internal/features"
import { describe, expect, it } from "vitest"

import {
  newProjectCommand,
  newProjectDirProblem,
  newProjectHosts,
  newProjectImplied,
  newProjectQuery,
  planNewProject,
  readNewProjectQuery,
  shellQuote,
  withNewProjectDefaults,
} from "../src/console/runtime/client/new-project.ts"
import { isConsoleNewProjectPath } from "../src/console/runtime/client/project-session.ts"

import type { NewProjectStack } from "../src/console/runtime/client/new-project.ts"

const ticket = { pendingId: "Q2xp_bk-9wAa3xYz", verifier: "a".repeat(64) }

function stack(input: Partial<NewProjectStack>): NewProjectStack {
  return withNewProjectDefaults({ dir: "my-app", features: [], options: {}, ...input })
}

describe("planNewProject", () => {
  it("marks the features that a host cannot run, and blocks the command only when one is on", () => {
    const plan = planNewProject(stack({ host: "netlify", features: ["kv"], options: { "kv.driver": "upstash" } }))
    const queue = plan.features.find(row => row.id === "queue")!
    expect(queue.support).toMatchObject({ level: "unsupported" })
    expect(queue.state).toEqual({ kind: "off" })
    expect(plan.problems).toEqual([])

    const picked = planNewProject(stack({ host: "netlify", features: ["kv", "queue"], options: { "kv.driver": "upstash" } }))
    expect(picked.problems).toEqual([{ field: "features", feature: "queue", message: "Queue is not available on Netlify. Turn it off, or pick another host." }])
    expect(newProjectCommand(stack({ host: "netlify", features: ["kv", "queue"] }), ticket)).toBeUndefined()
  })

  it("adds implied features with the feature that turns each on, as the catalog does", () => {
    const plan = planNewProject(stack({ host: "cloudflare", features: ["console"] }))
    expect(plan.features.find(row => row.id === "comments")!.state).toEqual({ kind: "implied", by: ["console"] })
    expect(plan.features.find(row => row.id === "database")!.state).toEqual({ kind: "implied", by: ["comments"] })
    // A feature that is also picked stays picked.
    const picked = planNewProject(stack({ host: "cloudflare", features: ["comments", "database"] }))
    expect(picked.features.find(row => row.id === "database")!.state).toEqual({ kind: "on" })
  })

  it("follows the host exceptions of an implication", () => {
    expect([...newProjectImplied(["agent"], "cloudflare").keys()]).toEqual(["workflow"])
    expect([...newProjectImplied(["agent"], "netlify").keys()]).toEqual([])
    expect([...newProjectImplied(["agent"], undefined).keys()]).toEqual(["workflow"])
  })

  it("implies the same features as impliedFeatures() for every feature on every host", () => {
    for (const host of newProjectHosts.map(entry => entry.id)) {
      for (const id of featureIds) {
        expect([...newProjectImplied([id], host).keys()].sort(), `${id} on ${host}`).toEqual(impliedFeatures([id], host).sort())
      }
    }
  })

  it("turns on KV when cache.driver chooses it, and fills the options of both", () => {
    const value = stack({ host: "netlify", features: ["cache"] })
    const plan = planNewProject(value)
    expect(plan.features.find(row => row.id === "kv")!.state).toEqual({ kind: "implied", by: ["cache"] })
    expect(plan.options.map(input => input.path)).toEqual(["cache.driver", "kv.driver"])
    expect(value.options).toEqual({ "cache.driver": "kv", "kv.driver": "upstash" })
    expect(plan.problems).toEqual([])
  })

  it("asks for the explicit option of each feature on the host, with the catalog detail", () => {
    const plan = planNewProject(stack({ host: "vercel", features: ["email", "kv"] }))
    expect(plan.options).toEqual([
      { feature: "email", path: "email.driver", choices: ["resend"], detail: (featureSupport("email", "vercel") as { detail: string }).detail },
    ])
    // A single choice is filled in, so the stack is ready.
    expect(plan.problems).toEqual([])
  })

  it("asks for the explicit options of implied features too", () => {
    const plan = planNewProject(stack({ host: "deno", features: ["comments"] }))
    expect(plan.options.map(input => input.path)).toEqual(["database.connection.url"])
    expect(plan.problems).toEqual([{ field: "option", path: "database.connection.url", message: "Enter a value for database.connection.url." }])
    const filled = planNewProject(stack({ host: "deno", features: ["comments"], options: { "database.connection.url": "libsql://db.example.com" } }))
    expect(filled.problems).toEqual([])
  })

  it("asks for every explicit option in the catalog", () => {
    for (const host of newProjectHosts.map(entry => entry.id)) {
      for (const id of featureIds) {
        const support = featureSupport(id, host)
        if (support.level !== "explicit") continue
        const plan = planNewProject(stack({ host, features: [id] }))
        expect(plan.options.some(input => input.feature === id && input.path.startsWith(support.option)), `${id} on ${host}`).toBe(true)
      }
    }
  })

  it("asks for the options that vitehub add requires beyond the catalog", () => {
    expect(planNewProject(stack({ host: "node", features: ["schedule"] })).options.map(input => input.path)).toEqual(["schedule.runtime.driver"])
    expect(planNewProject(stack({ host: "cloudflare", features: ["schedule"] })).options).toEqual([])
    expect(planNewProject(stack({ host: "cloudflare", features: ["console"] })).options.map(input => input.path)).toEqual(["console.auth"])
    expect(planNewProject(stack({ host: "cloudflare", features: ["observability"] })).problems).toEqual([
      { field: "option", path: "observability.service", message: "Enter a value for observability.service." },
    ])
  })

  it("rejects a value that is not one of the choices", () => {
    const plan = planNewProject({ dir: "my-app", host: "vercel", features: ["email"], options: { "email.driver": "smtp" } })
    expect(plan.problems).toEqual([{ field: "option", path: "email.driver", message: "email.driver must be resend." }])
  })

  it("needs a host and a folder name that vite-hub init reads as a folder", () => {
    expect(planNewProject(stack({ dir: "" })).problems.map(problem => problem.field)).toEqual(["dir", "host"])
    expect(newProjectDirProblem("my-app")).toBeUndefined()
    expect(newProjectDirProblem("Shop_2.web")).toBeUndefined()
    for (const dir of ["--yes", "-x", ".hidden", "..", "a/b", "my app", "a".repeat(101)]) expect(newProjectDirProblem(dir), dir).toBeDefined()
  })

  it("shows Env as on by default and never puts it in --features", () => {
    const plan = planNewProject(stack({ host: "node", features: ["env", "kv"] }))
    expect(plan.features.find(row => row.id === "env")!.state).toEqual({ kind: "default" })
    expect(newProjectCommand(stack({ host: "node", features: ["env", "kv"] }))).toBe("pnpm dlx vite-hub init my-app --host node --features kv --yes")
  })
})

describe("new project query", () => {
  it("round-trips a stack through the URL query", () => {
    const value = stack({ dir: "shop", host: "vercel", features: ["email", "kv", "queue"], options: { "email.driver": "resend" } })
    const query = newProjectQuery(value)
    expect(query).toBe("?dir=shop&host=vercel&features=email%2Ckv%2Cqueue&option=email.driver%3Dresend")
    expect(readNewProjectQuery(query)).toEqual(value)
  })

  it("round-trips values that need encoding", () => {
    const value = stack({ host: "deno", features: ["comments"], options: { "database.connection.url": "libsql://db.example.com/x?a=b&c=d e" } })
    expect(readNewProjectQuery(newProjectQuery(value))).toEqual(value)
  })

  it("keeps only the options that the stack asks for", () => {
    const value = stack({ host: "cloudflare", features: ["email"], options: { "email.driver": "resend" } })
    expect(newProjectQuery(value)).toBe("?host=cloudflare&features=email")
  })

  it("drops unknown hosts and features, and orders features as the catalog does", () => {
    expect(readNewProjectQuery("?host=dev&features=queue,nope,kv,kv")).toEqual({ dir: "my-app", features: ["kv", "queue"], options: {} })
    expect(newProjectQuery(stack({}))).toBe("")
  })

  it("matches only the /new page below the Console base", () => {
    expect(isConsoleNewProjectPath("/new", "/")).toBe(true)
    expect(isConsoleNewProjectPath("/new/", "/")).toBe(true)
    expect(isConsoleNewProjectPath("/console/new", "/console/")).toBe(true)
    expect(isConsoleNewProjectPath("/new", "/console/")).toBe(false)
    expect(isConsoleNewProjectPath("/newer", "/")).toBe(false)
  })
})

describe("newProjectCommand", () => {
  it("prints the vite-hub init command with the Console link", () => {
    const value = stack({ host: "cloudflare", features: ["kv", "queue"] })
    expect(newProjectCommand(value, ticket)).toBe(`pnpm dlx vite-hub init my-app --host cloudflare --features kv,queue --console Q2xp_bk-9wAa3xYz:sha256:${"a".repeat(64)} --yes`)
  })

  it("prints each option as --option feature.key=value, quoted for the shell", () => {
    const value = stack({ host: "deno", features: ["comments", "email"], options: { "database.connection.url": "libsql://db.example.com/x?a=b&c='d'", "email.driver": "resend" } })
    expect(newProjectCommand(value)).toBe(
      `pnpm dlx vite-hub init my-app --host deno --features comments,email --option 'database.connection.url=libsql://db.example.com/x?a=b&c='\\''d'\\''' --option email.driver=resend --yes`,
    )
  })

  it("prints an empty feature list as an empty argument", () => {
    expect(newProjectCommand(stack({ host: "node" }))).toBe("pnpm dlx vite-hub init my-app --host node --features '' --yes")
  })

  it("puts a link id that starts with a dash after =, so it does not read as a flag", () => {
    expect(newProjectCommand(stack({ host: "node" }), { ...ticket, pendingId: "--abcdefgh" })).toContain(` --console=--abcdefgh:sha256:${"a".repeat(64)} --yes`)
  })

  it("quotes like a POSIX shell", () => {
    expect(shellQuote("my-app")).toBe("my-app")
    expect(shellQuote("a b")).toBe("'a b'")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  })

  it("never prints the command of a stack with problems", () => {
    expect(newProjectCommand(stack({ features: ["kv"] }), ticket)).toBeUndefined()
    expect(newProjectCommand(stack({ host: "node", dir: "-x" }), ticket)).toBeUndefined()
  })

  it("lists every feature title from the catalog", () => {
    expect(planNewProject(stack({})).features.map(row => row.title)).toEqual(featureIds.map(id => features[id].title))
  })
})
