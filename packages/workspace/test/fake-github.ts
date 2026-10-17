import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

/** One file of a fake commit tree. `path` is from the repository root. */
export interface FakeTreeEntry {
  mode: string
  path: string
  sha: string
  size: number
}

export interface FakeCommit {
  author?: { date: string, email?: string, login?: string, name?: string }
  message: string
  parents: string[]
  sha: string
  tree: FakeTreeEntry[]
}

export interface FakeRequest {
  body?: Record<string, unknown>
  headers: Headers
  method: string
  /** The GraphQL operation name, for `POST /graphql`. */
  operation?: string
  /** The decoded path. */
  path: string
  /** The path as sent, with its percent encoding. */
  rawPath: string
  search: URLSearchParams
}

export interface CommitOnBranchInput {
  branch: { branchName: string, repositoryNameWithOwner: string }
  expectedHeadOid: string
  fileChanges: { additions?: Array<{ contents: string, path: string }>, deletions?: Array<{ path: string }> }
  message: { body?: string, headline: string }
}

/** Changes for `FakeGitHub.commit()`: content, `null` to delete, or content with a mode. */
export type FakeChanges = Record<string, string | Uint8Array | null | { content: string | Uint8Array, mode: string }>

const zeroOid = "0".repeat(40)

/** A full commit sha for a readable test label. Forges accept only full shas as commit ids. A full sha stays as it is. */
export function fakeSha(label: string): string {
  return /^[0-9a-f]{40}$/.test(label) ? label : createHash("sha1").update(label).digest("hex")
}

export const baseSha = fakeSha("base-sha")

export function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content)
}

export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
}

export function textSha(content: string): string {
  return gitBlobSha(textBytes(content))
}

/** The text of a base64 `createCommitOnBranch` addition. */
export function additionText(contents: string): string {
  return Buffer.from(contents, "base64").toString("utf8")
}

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? textBytes(content) : new Uint8Array(content)
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return Response.json(value, init)
}

function failure(status: number, message: string): Response {
  return json({ message }, { status })
}

/**
 * A fake of the GitHub REST and GraphQL endpoints that the Workspace GitHub Store and history use.
 * Install `fake.fetch` as the global `fetch`.
 */
export function createFakeGitHub(options: { owner?: string, repo?: string } = {}) {
  const owner = options.owner ?? "onmax"
  const repo = options.repo ?? "repo"
  const prefix = `/repos/${owner}/${repo}`
  const blobs = new Map<string, Uint8Array>()
  const commits = new Map<string, FakeCommit>()
  const branches = new Map<string, string>()
  const trees = new Map<string, FakeTreeEntry[]>()
  const requests: FakeRequest[] = []
  const overrides: Array<(request: FakeRequest) => Response | undefined> = []
  let commitIndex = 0
  let treeIndex = 0

  const state = {
    archive: textBytes("archive"),
    archiveFailures: 0,
    defaultBranch: "main",
    truncated: false,
  }

  function putBlob(content: string | Uint8Array): { bytes: Uint8Array, sha: string } {
    const bytes = bytesOf(content)
    const sha = gitBlobSha(bytes)
    blobs.set(sha, bytes)
    return { bytes, sha }
  }

  function applyChanges(tree: FakeTreeEntry[], changes: FakeChanges): FakeTreeEntry[] {
    const next = new Map(tree.map(entry => [entry.path, entry]))
    for (const [path, change] of Object.entries(changes)) {
      if (change === null) {
        next.delete(path)
        continue
      }
      const { content, mode } = typeof change === "string" || change instanceof Uint8Array
        ? { content: change, mode: next.get(path)?.mode ?? "100644" }
        : change
      const blob = putBlob(content)
      next.set(path, { mode, path, sha: blob.sha, size: blob.bytes.byteLength })
    }
    return [...next.values()]
  }

  function addCommit(input: { message: string, parents: string[], sha?: string, tree: FakeTreeEntry[] }): FakeCommit {
    const commit: FakeCommit = {
      author: { date: "2026-10-15T08:00:00Z", email: "bot@example.com", name: "Bot" },
      message: input.message,
      parents: input.parents,
      sha: fakeSha(input.sha ?? `commit-sha-${++commitIndex}`),
      tree: input.tree,
    }
    commits.set(commit.sha, commit)
    return commit
  }

  addCommit({ message: "base", parents: [], sha: baseSha, tree: [] })
  branches.set("main", baseSha)

  function resolve(ref: string): FakeCommit | undefined {
    const name = ref.startsWith("heads/") ? ref.slice("heads/".length) : ref
    const sha = branches.get(name) ?? (ref.startsWith("heads/") ? undefined : ref)
    return sha ? commits.get(sha) : undefined
  }

  function restCommit(commit: FakeCommit) {
    const author = commit.author && { date: commit.author.date, email: commit.author.email, name: commit.author.name }
    return {
      author: commit.author?.login ? { login: commit.author.login } : null,
      commit: { author, committer: author, message: commit.message, tree: { sha: `tree-of-${commit.sha}` } },
      html_url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
      parents: commit.parents.map(sha => ({ sha })),
      sha: commit.sha,
    }
  }

  function treeEntries(entries: FakeTreeEntry[]) {
    return entries.map(entry => ({ mode: entry.mode, path: entry.path, sha: entry.sha, size: entry.size, type: "blob" }))
  }

  function blobBody(sha: string, bytes: Uint8Array) {
    return { content: Buffer.from(bytes).toString("base64"), encoding: "base64", sha, size: bytes.byteLength }
  }

  function page<T>(items: T[], url: URL): Response {
    const perPage = Number(url.searchParams.get("per_page") || "30")
    const current = Number(url.searchParams.get("page") || "1")
    const slice = items.slice((current - 1) * perPage, current * perPage)
    const headers = new Headers()
    if (current * perPage < items.length) {
      const next = new URL(url)
      next.searchParams.set("page", String(current + 1))
      headers.set("link", `<${next}>; rel="next"`)
    }
    return json(slice, { headers })
  }

  function ancestors(sha: string): FakeCommit[] {
    const result: FakeCommit[] = []
    let current = commits.get(sha)
    while (current) {
      result.push(current)
      current = current.parents[0] ? commits.get(current.parents[0]) : undefined
    }
    return result
  }

  function graphql(request: FakeRequest): Response {
    const variables = (request.body?.variables ?? {}) as { input?: Record<string, unknown> }
    const input = variables.input ?? {}
    if (request.operation === "RepositoryId") return json({ data: { repository: { id: "R_repo" } } })
    if (request.operation === "UpdateRefs") {
      const [update] = input.refUpdates as Array<{ afterOid: string, beforeOid: string, name: string }>
      const name = update!.name.replace(/^refs\/heads\//, "")
      if (update!.afterOid === zeroOid) branches.delete(name)
      else branches.set(name, update!.afterOid)
      return json({ data: { updateRefs: { clientMutationId: null } } })
    }
    if (request.operation === "CreateCommitOnBranch") {
      const branch = (input.branch as { branchName: string }).branchName
      const expected = input.expectedHeadOid as string
      const head = branches.get(branch)
      if (!head || head !== expected) {
        return json({ errors: [{ message: `Expected branch to point to "${expected}" but it did not. Pull and try again.` }] })
      }
      const fileChanges = input.fileChanges as CommitOnBranchInput["fileChanges"]
      const parent = commits.get(head)!
      const changes: FakeChanges = {}
      for (const deletion of fileChanges.deletions ?? []) {
        if (!parent.tree.some(entry => entry.path === deletion.path)) {
          return json({ errors: [{ message: `A path was requested for deletion which does not exist as of commit oid \`${head}\`` }] })
        }
        changes[deletion.path] = null
      }
      for (const addition of fileChanges.additions ?? []) changes[addition.path] = new Uint8Array(Buffer.from(addition.contents, "base64"))
      const message = input.message as CommitOnBranchInput["message"]
      const commit = addCommit({
        message: message.body ? `${message.headline}\n\n${message.body}` : message.headline,
        parents: [head],
        tree: applyChanges(parent.tree, changes),
      })
      branches.set(branch, commit.sha)
      const actor = { date: commit.author!.date, email: commit.author!.email, name: commit.author!.name, user: null }
      return json({ data: { createCommitOnBranch: { commit: {
        author: actor,
        committer: actor,
        message: commit.message,
        oid: commit.sha,
        parents: { nodes: [{ oid: head }] },
        url: `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
      } } } })
    }
    return failure(400, `Unknown GraphQL operation ${request.operation}`)
  }

  function route(request: FakeRequest, url: URL): Response {
    const { method, path } = request
    if (path === "/graphql" && method === "POST") return graphql(request)
    if (!path.startsWith(prefix)) return failure(404, "Not Found")
    const rest = path.slice(prefix.length)
    if (rest === "" && method === "GET") {
      return json({ default_branch: state.defaultBranch, full_name: `${owner}/${repo}`, name: repo, owner: { login: owner }, private: true })
    }
    if (rest === "/branches" && method === "GET") {
      return page([...branches].sort(([left], [right]) => left.localeCompare(right)).map(([name, sha]) => ({ commit: { sha }, name, protected: false })), url)
    }
    if (rest === "/commits" && method === "GET") {
      const head = resolve(url.searchParams.get("sha") || state.defaultBranch)
      if (!head) return failure(404, "Not Found")
      return page(ancestors(head.sha).map(restCommit), url)
    }
    if (rest.startsWith("/commits/") && method === "GET") {
      const ref = rest.slice("/commits/".length)
      const commit = resolve(ref)
      return commit ? json(restCommit(commit)) : failure(422, `No commit found for SHA: ${ref}`)
    }
    if (rest.startsWith("/tarball/") && method === "GET") {
      if (state.archiveFailures-- > 0) return new Response("retry", { headers: { "retry-after": "0" }, status: 503 })
      return new Response(state.archive)
    }
    if (rest.startsWith("/contents/") && method === "GET") {
      const commit = resolve(url.searchParams.get("ref") || state.defaultBranch)
      let entry = commit?.tree.find(item => item.path === rest.slice("/contents/".length))
      // GitHub answers a symlink path with the file that it points at.
      if (entry?.mode === "120000") {
        const target = new TextDecoder().decode(blobs.get(entry.sha))
        const base = entry.path.split("/").slice(0, -1).join("/")
        entry = commit?.tree.find(item => item.path === (base ? `${base}/${target}` : target)) ?? entry
      }
      const bytes = entry ? blobs.get(entry.sha) : undefined
      if (!entry || !bytes) return failure(404, "Not Found")
      return json({ ...blobBody(entry.sha, bytes), name: entry.path.split("/").at(-1), path: entry.path, type: "file" })
    }
    if (rest.startsWith("/git/blobs/") && method === "GET") {
      const sha = rest.slice("/git/blobs/".length)
      const bytes = blobs.get(sha)
      return bytes ? json(blobBody(sha, bytes)) : failure(404, "Not Found")
    }
    if (rest.startsWith("/git/trees/") && method === "GET") {
      const ref = rest.slice("/git/trees/".length)
      const entries = trees.get(ref) ?? resolve(ref)?.tree
      if (!entries) return failure(404, "Not Found")
      return json({ sha: `tree-${ref}`, tree: treeEntries(entries), truncated: state.truncated })
    }
    if (rest.startsWith("/git/ref/heads/") && method === "GET") {
      const sha = branches.get(rest.slice("/git/ref/heads/".length))
      return sha ? json({ object: { sha, type: "commit" } }) : failure(404, "Not Found")
    }
    if (rest.startsWith("/git/commits/") && method === "GET") {
      const sha = rest.slice("/git/commits/".length)
      const commit = commits.get(sha)
      if (!commit) return failure(404, "Not Found")
      trees.set(`tree-of-${sha}`, commit.tree)
      return json({ sha, tree: { sha: `tree-of-${sha}` } })
    }
    if (rest === "/git/blobs" && method === "POST") {
      const blob = putBlob(new Uint8Array(Buffer.from(String(request.body?.content), "base64")))
      return json({ sha: blob.sha }, { status: 201 })
    }
    if (rest === "/git/trees" && method === "POST") {
      const base = trees.get(String(request.body?.base_tree)) ?? []
      const next = new Map(base.map(entry => [entry.path, entry]))
      for (const entry of (request.body?.tree ?? []) as Array<{ mode: string, path: string, sha: string | null }>) {
        if (entry.sha === null) next.delete(entry.path)
        else next.set(entry.path, { mode: entry.mode, path: entry.path, sha: entry.sha, size: blobs.get(entry.sha)?.byteLength ?? 0 })
      }
      const sha = `tree-sha-${++treeIndex}`
      trees.set(sha, [...next.values()])
      return json({ sha }, { status: 201 })
    }
    if (rest === "/git/commits" && method === "POST") {
      const commit = addCommit({
        message: String(request.body?.message),
        parents: request.body?.parents as string[],
        tree: trees.get(String(request.body?.tree)) ?? [],
      })
      return json({ sha: commit.sha }, { status: 201 })
    }
    if (rest === "/git/refs" && method === "POST") {
      const name = String(request.body?.ref).replace(/^refs\/heads\//, "")
      if (branches.has(name)) return failure(422, "Reference already exists")
      branches.set(name, String(request.body?.sha))
      return json({ object: { sha: request.body?.sha }, ref: request.body?.ref }, { status: 201 })
    }
    if (rest.startsWith("/git/refs/heads/") && method === "PATCH") {
      const name = rest.slice("/git/refs/heads/".length)
      const commit = commits.get(String(request.body?.sha))
      if (!branches.has(name) || !commit) return failure(422, "Reference does not exist")
      if (commit.parents[0] !== branches.get(name)) return failure(422, "Update is not a fast forward")
      branches.set(name, commit.sha)
      return json({ object: { sha: commit.sha } })
    }
    return failure(404, "Not Found")
  }

  async function fakeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init.method || "GET").toUpperCase()
    const parsed: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    const body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined
    const request: FakeRequest = {
      body,
      headers: new Headers(init.headers),
      method,
      ...(url.pathname === "/graphql" && typeof body?.operationName === "string" ? { operation: body.operationName } : {}),
      path: decodeURIComponent(url.pathname),
      rawPath: url.pathname,
      search: url.searchParams,
    }
    requests.push(request)
    for (const override of overrides) {
      const response = override(request)
      if (response) return response
    }
    return route(request, url)
  }

  return {
    blobs,
    commits,
    fetch: fakeFetch,
    requests,
    state,
    /** The head of `branch`. */
    head: (branch = "main") => branches.get(branch),
    /** The files at the head of `branch`. */
    tree: (branch = "main") => commits.get(branches.get(branch) ?? "")?.tree ?? [],
    /** Set a branch head for tests that model an external commit. */
    setBranch(branch: string, label: string, tree: FakeTreeEntry[] = []) {
      const sha = fakeSha(label)
      if (!commits.has(sha)) addCommit({ message: "external change", parents: [], sha, tree })
      else commits.get(sha)!.tree = tree
      branches.set(branch, sha)
    },
    /** Add a file to the head commit of `branch` in place, as if the commit always had it. */
    seed(path: string, content: string | Uint8Array, mode = "100644", branch = "main") {
      const commit = commits.get(branches.get(branch)!)!
      commit.tree = applyChanges(commit.tree, { [path]: { content, mode } })
    },
    /** Move `branch` to a new commit with `changes`, as another writer would. */
    commit(branch: string, changes: FakeChanges, input: { message?: string, sha?: string } = {}) {
      const parent = branches.get(branch)
      const commit = addCommit({
        message: input.message ?? "remote change",
        parents: parent ? [parent] : [],
        sha: input.sha,
        tree: applyChanges(parent ? commits.get(parent)!.tree : [], changes),
      })
      branches.set(branch, commit.sha)
      return commit.sha
    },
    /** Answer the requests that `respond` matches before the fake does. */
    respond(respond: (request: FakeRequest) => Response | undefined) {
      overrides.push(respond)
    },
    /** Requests that write: every method but GET, except the GraphQL repository lookup. */
    writes: () => requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId"),
    /** The `createCommitOnBranch` inputs that the fake received. */
    commitInputs: () => requests.filter(request => request.operation === "CreateCommitOnBranch")
      .map(request => (request.body as { variables: { input: CommitOnBranchInput } }).variables.input),
  }
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>
