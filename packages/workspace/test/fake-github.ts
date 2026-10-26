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
  const pulls: Array<{ base: string, body: string | null, draft: boolean, head: string, merged: boolean, number: number, state: "closed" | "open", title: string }> = []
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

  /** Every commit that `sha` reaches, through all parents. */
  function reachable(sha: string): Set<string> {
    const seen = new Set<string>()
    const queue = [sha]
    while (queue.length) {
      const next = queue.pop()!
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(...(commits.get(next)?.parents ?? []))
    }
    return seen
  }

  /** The nearest commit that both reach, walking back from `ours`. */
  function mergeBase(ours: string, theirs: string): string | undefined {
    const theirAncestors = reachable(theirs)
    const queue = [ours]
    const seen = new Set<string>()
    while (queue.length) {
      const next = queue.shift()!
      if (seen.has(next)) continue
      seen.add(next)
      if (theirAncestors.has(next)) return next
      queue.push(...(commits.get(next)?.parents ?? []))
    }
  }

  /** The tree that results from taking the changes of `theirs` since `ancestor` onto `ours`. Null on a conflict. */
  function mergeTrees(ancestor: string | undefined, ours: string, theirs: string): FakeTreeEntry[] | null {
    const shaOf = (tree: FakeTreeEntry[]) => new Map(tree.map(entry => [entry.path, entry]))
    const before = shaOf(ancestor ? commits.get(ancestor)!.tree : [])
    const mine = shaOf(commits.get(ours)!.tree)
    const other = shaOf(commits.get(theirs)!.tree)
    const merged: FakeTreeEntry[] = []
    for (const path of new Set([...before.keys(), ...mine.keys(), ...other.keys()])) {
      const b = before.get(path)?.sha
      const o = mine.get(path)?.sha
      const t = other.get(path)?.sha
      let pick: FakeTreeEntry | undefined
      if (o === t || t === b) pick = mine.get(path)
      else if (o === b) pick = other.get(path)
      else return null
      if (pick) merged.push(pick)
    }
    return merged
  }

  /** Merge `head` into `base`: a three-way merge of whole files. It reports a conflict when both changed the same file. */
  function mergeBranches(base: string, head: string, message: string): { conflict: true } | { sha: string } | { upToDate: true } {
    const ours = branches.get(base)!
    const theirs = branches.get(head)!
    if (reachable(ours).has(theirs)) return { upToDate: true }
    const merged = mergeTrees(mergeBase(ours, theirs), ours, theirs)
    if (!merged) return { conflict: true }
    const commit = addCommit({ message, parents: [ours, theirs], tree: merged })
    branches.set(base, commit.sha)
    return { sha: commit.sha }
  }

  function pullBody(pull: (typeof pulls)[number]) {
    return {
      base: { ref: pull.base, sha: branches.get(pull.base) ?? zeroOid },
      body: pull.body,
      draft: pull.draft,
      head: { ref: pull.head, sha: branches.get(pull.head) ?? zeroOid },
      html_url: `https://github.com/${owner}/${repo}/pull/${pull.number}`,
      merged: pull.merged,
      node_id: `PR_${pull.number}`,
      number: pull.number,
      state: pull.state,
      title: pull.title,
      user: { login: "bot" },
    }
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
    if (rest.startsWith("/compare/") && method === "GET") {
      const [left, right] = rest.slice("/compare/".length).split("...")
      const base = left && right ? mergeBase(left, right) : undefined
      return base ? json({ merge_base_commit: { sha: base } }) : failure(404, "Not Found")
    }
    if (rest.startsWith("/git/matching-refs/heads/") && method === "GET") {
      const prefix = rest.slice("/git/matching-refs/heads/".length)
      return page([...branches].filter(([name]) => name.startsWith(prefix)).sort(([left], [right]) => left.localeCompare(right)).map(([name, sha]) => ({ object: { sha, type: "commit" }, ref: `refs/heads/${name}` })), url)
    }
    if (rest.startsWith("/git/refs/heads/") && method === "DELETE") {
      return branches.delete(rest.slice("/git/refs/heads/".length)) ? new Response(null, { status: 204 }) : failure(422, "Reference does not exist")
    }
    if (rest === "/merges" && method === "POST") {
      const base = String(request.body?.base)
      const head = String(request.body?.head)
      if (!branches.has(base) || !branches.has(head)) return failure(404, "Base does not exist")
      const result = mergeBranches(base, head, String(request.body?.commit_message ?? `Merge ${head} into ${base}`))
      if ("conflict" in result) return failure(409, "Merge conflict")
      if ("upToDate" in result) return new Response(null, { status: 204 })
      return json({ sha: result.sha }, { status: 201 })
    }
    if (rest === "/pulls" && method === "POST") {
      const head = String(request.body?.head)
      const base = String(request.body?.base)
      if (!branches.has(head) || !branches.has(base)) return failure(422, "Validation Failed: head or base does not exist")
      const pull = { base, body: typeof request.body?.body === "string" ? request.body.body : null, draft: request.body?.draft === true, head, merged: false, number: pulls.length + 1, state: "open" as const, title: String(request.body?.title) }
      pulls.push(pull)
      return json(pullBody(pull), { status: 201 })
    }
    if (rest === "/pulls" && method === "GET") {
      const state = url.searchParams.get("state") ?? "open"
      const head = url.searchParams.get("head")
      return page(pulls.filter(pull => (state === "all" || pull.state === state) && (!head || head === `${owner}:${pull.head}`)).map(pullBody).reverse(), url)
    }
    if (rest === "/branches" && method === "GET") {
      return page([...branches].sort(([left], [right]) => left.localeCompare(right)).map(([name, sha]) => ({ commit: { sha }, name, protected: false })), url)
    }
    if (rest === "/commits" && method === "GET") {
      const head = resolve(url.searchParams.get("sha") || state.defaultBranch)
      if (!head) return failure(404, "Not Found")
      // GitHub lists the commits that changed `path`, a file or a folder.
      const path = url.searchParams.get("path")
      const touches = (commit: FakeCommit) => {
        const before = new Map((commits.get(commit.parents[0] ?? "")?.tree ?? []).map(entry => [entry.path, entry.sha]))
        const after = new Map(commit.tree.map(entry => [entry.path, entry.sha]))
        return [...new Set([...before.keys(), ...after.keys()])].some(name => (name === path || name.startsWith(`${path}/`)) && before.get(name) !== after.get(name))
      }
      return page(ancestors(head.sha).filter(commit => !path || touches(commit)).map(restCommit), url)
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
    /** The pull requests that were opened. */
    pulls,
    /** Every branch name. */
    branchNames: () => [...branches.keys()],
    /** Open a pull request for branches that exist, as a person would. */
    openPull(head: string, base: string, title: string) {
      const pull = { base, body: null, draft: false, head, merged: false, number: pulls.length + 1, state: "open" as const, title }
      pulls.push(pull)
      return pull.number
    },
    /**
     * Merge a pull request the way GitHub does. `merge` makes a merge commit, `squash` one commit with the branch's
     * changes, and `rebase` replays each commit of the branch on the base. Only a merge commit keeps the branch's
     * commits in the history of the base.
     */
    mergePullRequest(number: number, method: "merge" | "rebase" | "squash" = "merge") {
      const pull = pulls.find(entry => entry.number === number)!
      const ours = branches.get(pull.base)!
      const theirs = branches.get(pull.head)!
      if (method === "merge") {
        const result = mergeBranches(pull.base, pull.head, `Merge pull request #${number} from ${pull.head}`)
        if ("conflict" in result) throw new Error("The fake cannot merge a conflicting pull request.")
      }
      else if (method === "squash") {
        const tree = mergeTrees(mergeBase(ours, theirs), ours, theirs)
        if (!tree) throw new Error("The fake cannot merge a conflicting pull request.")
        branches.set(pull.base, addCommit({ message: `${pull.title} (#${number})`, parents: [ours], tree }).sha)
      }
      else {
        // The commits of the branch since the base, oldest first, each replayed as the changes it made.
        const stop = mergeBase(ours, theirs)
        const chain: FakeCommit[] = []
        for (let current = commits.get(theirs); current && current.sha !== stop; current = current.parents[0] ? commits.get(current.parents[0]) : undefined) chain.unshift(current)
        for (const commit of chain) {
          const before = new Map((commits.get(commit.parents[0] ?? "")?.tree ?? []).map(entry => [entry.path, entry]))
          const changes: FakeChanges = {}
          for (const entry of commit.tree) if (before.get(entry.path)?.sha !== entry.sha) changes[entry.path] = { content: blobs.get(entry.sha) ?? new Uint8Array(), mode: entry.mode }
          for (const path of before.keys()) if (!commit.tree.some(entry => entry.path === path)) changes[path] = null
          const head = branches.get(pull.base)!
          branches.set(pull.base, addCommit({ message: commit.message, parents: [head], tree: applyChanges(commits.get(head)!.tree, changes) }).sha)
        }
      }
      pull.state = "closed"
      pull.merged = true
    },
    /** Requests that write: every method but GET, except the GraphQL repository lookup. */
    writes: () => requests.filter(request => request.method !== "GET" && request.operation !== "RepositoryId"),
    /** The `createCommitOnBranch` inputs that the fake received. */
    commitInputs: () => requests.filter(request => request.operation === "CreateCommitOnBranch")
      .map(request => (request.body as { variables: { input: CommitOnBranchInput } }).variables.input),
  }
}

export type FakeGitHub = ReturnType<typeof createFakeGitHub>
