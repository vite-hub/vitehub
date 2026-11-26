import { loadViteHubPageTools, stopViteHubPageTools } from "@vite-hub/internal/runtime/page-tools-loader"

import { commentsUnansweredError } from "../client-diagnostics.ts"
import { apiError, useCommentsOverlayBackend } from "../overlay/api.ts"
import { embedPath } from "./protocol.ts"

import type { ViteHubPageSession } from "@vite-hub/internal/runtime/page-tools-shared"
import type { CommentsOverlayBackend, CommentsSession } from "../overlay/api.ts"
import type { RestTransport } from "../rest-transport.ts"
import type { CommentThread } from "../types.ts"
import type { EmbedFrame } from "./protocol.ts"

const session: ViteHubPageSession = { tools: [{ id: "comments", label: "Comments", icon: "i-lucide-message-square-text", script: "comments", param: "comment" }] }

/** The Hosted Comments project of the page, and the Console that serves it. */
export interface HostedProject {
  id: string
  /** The origin of the Console. */
  console: string
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
        return [undefined, project.repository ? { ...value, repository: project.repository } : value]
      }
      catch (error) {
        return [apiError(error), undefined]
      }
    },
    changes(listener) {
      let stop: (() => void) | undefined
      let stopped = false
      void frame.then((connected) => {
        if (!stopped) stop = connected.onChange(listener)
      }, () => undefined)
      return () => {
        stopped = true
        stop?.()
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
  await loadViteHubPageTools({
    pill: {
      name: "vitehub-hosted-comments-pill",
      label: "ViteHub Comments",
      off: "vitehub-hosted-comments-off",
      collapsed: "vitehub-hosted-comments-collapsed",
      dock: "vitehub-hosted-comments-dock",
      initialDock: { edge: "right", at: 85 },
    },
    session: async () => session,
    load: () => import("../overlay/index.ts"),
  })
}
