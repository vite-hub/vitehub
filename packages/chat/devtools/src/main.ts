import {
  chatDevtoolsRpcClear,
  chatDevtoolsRpcGetState,
  chatDevtoolsRpcSend,
  type ChatDevtoolsResult,
  type ChatDevtoolsTranscriptMessage,
} from "@vitehub/chat/devtools"
import "./style.css"

type DevtoolsRpcClient = {
  call<T>(name: string, params?: Record<string, unknown>): Promise<T>
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) {
    throw new Error(`Missing Chat DevTools DOM node ${selector}.`)
  }
  return element
}

const transcript = requireElement<HTMLDivElement>("#transcript")
const emptyState = requireElement<HTMLDivElement>("#empty-state")
const form = requireElement<HTMLFormElement>("#composer")
const input = requireElement<HTMLTextAreaElement>("#message-input")
const sendButton = requireElement<HTMLButtonElement>("#send-button")
const clearButton = requireElement<HTMLButtonElement>("#clear-button")
const chatSelect = requireElement<HTMLSelectElement>("#chat-select")

let rpc: DevtoolsRpcClient | undefined
let pending = false
let chatName = "chat"
let chats: string[] = []
let messages: ChatDevtoolsTranscriptMessage[] = []
let demoReply: ReturnType<typeof setTimeout> | undefined
let connectionHint = ""

function canUseComposer() {
  return !!rpc || !!connectionHint
}

function setPending(nextPending: boolean) {
  pending = nextPending
  renderControls()
}

function createMessage(author: ChatDevtoolsTranscriptMessage["author"], text: string): ChatDevtoolsTranscriptMessage {
  const chat = chatName || "chat"
  return {
    author,
    chat,
    id: globalThis.crypto?.randomUUID?.() || `${author}-${Date.now()}-${messages.length}`,
    text,
    threadId: `demo:${chat}`,
    timestamp: new Date().toISOString(),
  }
}

function applyResult(result: ChatDevtoolsResult) {
  chats = result.chats || []
  chatName = result.chatName || result.chats?.[0] || chatName || "chat"
  messages = result.messages || []
  render()
}

function escapeText(value: string) {
  const element = document.createElement("div")
  element.textContent = value
  return element.innerHTML
}

function renderControls() {
  const availableChats = [...new Set(chats.length ? chats : [chatName || "chat"])]

  chatSelect.hidden = availableChats.length <= 1
  chatSelect.disabled = !rpc || pending
  chatSelect.replaceChildren(...availableChats.map((name) => {
    const option = document.createElement("option")
    option.value = name
    option.textContent = name
    option.selected = name === chatName
    return option
  }))

  input.disabled = !canUseComposer() || pending
  sendButton.disabled = !canUseComposer() || pending || !input.value.trim()
  clearButton.disabled = !canUseComposer() || pending || messages.length === 0
}

function renderMessages() {
  transcript.querySelectorAll(".notice, .message").forEach(node => node.remove())

  if (connectionHint) {
    const notice = document.createElement("div")
    notice.className = "notice"
    notice.textContent = "Open from Vite DevTools to reach the local chat bridge. Direct access uses dummy replies."
    transcript.insertBefore(notice, emptyState)
  }

  for (const message of messages) {
    const article = document.createElement("article")
    article.className = `message message-${message.author}`
    article.innerHTML = `<p>${escapeText(message.text)}</p>`
    transcript.append(article)
  }

  emptyState.hidden = messages.length > 0
  emptyState.textContent = rpc || connectionHint ? "No messages yet." : "Connecting to Vite DevTools..."
  transcript.scrollTo({ top: transcript.scrollHeight })
}

function render() {
  renderControls()
  renderMessages()
}

function stopDemoReply() {
  if (demoReply) {
    clearTimeout(demoReply)
    demoReply = undefined
  }
}

function sendDemoMessage(text: string) {
  messages = [...messages, createMessage("user", text)]
  chats = [chatName || "chat"]
  render()
  stopDemoReply()
  demoReply = setTimeout(() => {
    messages = [...messages, createMessage("assistant", `Dummy reply from ${chatName || "chat"}: ${text}`)]
    setPending(false)
    render()
  }, 400)
}

async function refresh() {
  if (!rpc) {
    chats = [chatName || "chat"]
    render()
    return
  }

  setPending(true)
  try {
    applyResult(await rpc.call<ChatDevtoolsResult>(chatDevtoolsRpcGetState, { chatName }))
  }
  finally {
    setPending(false)
  }
}

async function send(text: string) {
  if (!rpc) {
    sendDemoMessage(text)
    return
  }

  applyResult(await rpc.call<ChatDevtoolsResult>(chatDevtoolsRpcSend, { chatName, text }))
}

async function clear() {
  if (!rpc) {
    stopDemoReply()
    messages = []
    render()
    return
  }

  applyResult(await rpc.call<ChatDevtoolsResult>(chatDevtoolsRpcClear, { chatName }))
}

input.addEventListener("input", () => {
  input.style.height = "auto"
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`
  renderControls()
})

chatSelect.addEventListener("change", () => {
  chatName = chatSelect.value || "chat"
  void refresh()
})

clearButton.addEventListener("click", async () => {
  if (pending) return
  setPending(true)
  try {
    await clear()
  }
  finally {
    setPending(false)
  }
})

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  if (pending) return

  const text = input.value.trim()
  if (!text) return

  input.value = ""
  input.style.height = "auto"
  setPending(true)
  try {
    await send(text)
  }
  finally {
    if (rpc) {
      setPending(false)
    }
  }
})

try {
  const { connectRemoteDevTools } = await import("@vitejs/devtools-kit/client")
  rpc = await connectRemoteDevTools() as DevtoolsRpcClient
  await refresh()
}
catch (cause) {
  connectionHint = cause instanceof Error ? cause.message : String(cause)
  chats = [chatName]
  render()
}
