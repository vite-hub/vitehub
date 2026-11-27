import { loadViteHubPageTools, stopViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"
import { viteHubPillButtonStyles } from "@vite-hub/internal/runtime/page-tools-shared"

import { commentsUnansweredError } from "../client-diagnostics.ts"
import { apiError, useCommentsOverlayBackend } from "../overlay/api.ts"
import { embedPath } from "./protocol.ts"

import type { ViteHubPageToolModule } from "@vite-hub/internal/runtime/page-tools-loader"
import type { CommentsOverlayBackend, CommentsSession } from "../overlay/api.ts"
import type { RestTransport } from "../rest-transport.ts"
import type { CommentThread } from "../types.ts"
import type { EmbedFrame } from "./protocol.ts"

const commentsTool = { id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "comments", param: "comment" }
const consoleTool = { id: "console", label: "Console", icon: "i-lucide-layout-dashboard", script: "console" }
const projectTool = { id: "projects", label: "Choose a team for Comments", icon: "", script: "projects" }
const pill = {
  name: "vitehub-hosted-comments-pill",
  label: "ViteHub Comments",
  off: "vitehub-hosted-comments-off",
  collapsed: "vitehub-hosted-comments-collapsed",
  dock: "vitehub-hosted-comments-dock",
  initialDock: { edge: "right", at: 85 },
} as const

/** The Hosted Comments project of the page, and the Console that serves it. */
export interface HostedProject {
  id: string
  /** The origin of the Console. */
  console: string
  consoleUrl?: string
  /** The GitHub repository of the site, `owner/name`, from `data-vitehub-repo` on the script tag. */
  repository?: string
}

interface Answers {
  list: CommentThread[]
  get: CommentThread | null
  create: CommentThread
  reply: CommentThread
  resolve: CommentThread
  reopen: CommentThread
}

function refused(): Promise<never> {
  return Promise.reject(commentsUnansweredError(405))
}

function backendOf(frame: Promise<EmbedFrame>, project: HostedProject): CommentsOverlayBackend {
  return {
    namespace: new URL(embedPath(project.id), project.console).href,
    async session(page) {
      try {
        // SAFETY: the frame answers `session` with the session that it built for this page.
        const value = (await (await frame).call("session", page)).value as CommentsSession
        if (project.consoleUrl && value.signIn?.provider === "console") {
          const url = new URL(value.signIn.url)
          url.searchParams.set("linked", "")
          value.signIn = { ...value.signIn, url: url.href }
        }
        return [undefined, project.repository ? { ...value, repository: project.repository } : value]
      }
      catch (error) {
        return [apiError(error), undefined]
      }
    },
    transport(onAnswer) {
      const call = async <M extends keyof Answers>(method: M, input: unknown): Promise<Answers[M]> => {
        const answer = await (await frame).call(method, input)
        onAnswer({ data: answer.value, people: answer.people })
        // SAFETY: the frame answers each method with the data of its Console route, as the Comments API does.
        return answer.value as Answers[M]
      }
      const transport: RestTransport = {
        list: query => call("list", query),
        get: input => call("get", input),
        create: ({ files: _files, outbox: _outbox, ...input }) => call("create", input),
        reply: ({ files: _files, outbox: _outbox, ...input }) => call("reply", input),
        resolve: input => call("resolve", { threadId: input.threadId }),
        reopen: input => call("reopen", { threadId: input.threadId }),
        edit: refused,
        delete: refused,
        users: async () => [],
        upload: refused,
        attachmentUrl: () => "",
      }
      return transport
    },
  }
}

/**
 * Shows the page tools with Comments, which reach the Console only through the embed frame. A second call, after a
 * sign-in, replaces the tools of the first with tools for the new account. It does not open them: the page stays as the
 * person left it, and they choose when to comment.
 */
export async function mountHostedComments(frame: Promise<EmbedFrame>, project: HostedProject): Promise<void> {
  stopViteHubPageTools()
  useCommentsOverlayBackend(backendOf(frame, project))
  const { consoleUrl } = project
  await loadViteHubPageTools({
    pill,
    session: async () => ({ tools: consoleUrl ? [commentsTool, consoleTool] : [commentsTool] }),
    load: tool => tool === "console" && consoleUrl ? Promise.resolve(consoleLink(consoleUrl)) : import("../overlay/index.ts"),
  })
}

function consoleLink(url: string): ViteHubPageToolModule {
  return { default({ bar, onOpen }) {
    const link = document.createElement("a")
    link.href = url
    link.textContent = "Console"
    const style = document.createElement("style")
    style.textContent = viteHubPillButtonStyles.replaceAll("button", "a")
    bar.attachShadow({ mode: "open" }).append(style, link)
    onOpen(() => { link.click(); return true })
  } }
}

export async function mountHostedProjectChoice(url: string, projects: readonly { team: string, choose: () => void }[]): Promise<void> {
  await loadViteHubPageTools({
    pill,
    session: async () => ({ tools: projects.length ? [projectTool, consoleTool] : [consoleTool] }),
    load: async script => script === "console" ? consoleLink(url) : {
      default({ bar }) {
        const select = document.createElement("select")
        select.setAttribute("aria-label", projectTool.label)
        select.append(new Option(projectTool.label, ""))
        for (const [index, project] of projects.entries()) select.append(new Option(project.team, String(index)))
        select.addEventListener("change", () => { if (select.selectedIndex > 0) projects[select.selectedIndex - 1]?.choose() })
        bar.append(select)
      },
    } satisfies ViteHubPageToolModule,
  })
}
