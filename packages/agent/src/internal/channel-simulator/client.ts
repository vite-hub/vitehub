import type { SimulatorConfig, SimulatorDocument, SimulatorElement, SimulatorForm, SimulatorMessage, SimulatorMessageRenderer, SimulatorTextArea, SimulatorUpdate, SimulatorView, SimulatorWindow } from "./types.ts"

/**
 * The browser client that every skin shares. The page embeds its source with `toString()`, so the function uses only
 * its parameters and browser globals. It keeps the messages, POSTs each user message to the Channel route as an AI SDK
 * chat request, and reads the reply from the AI SDK UI message stream. In an iframe, it does not take the focus, and it
 * posts `{ type: "vitehub:channel-reply" }` to its parent at the end of each reply.
 */
export function channelSimulatorClient(
  config: SimulatorConfig,
  skin: { message: SimulatorMessageRenderer, update: SimulatorUpdate },
  document: SimulatorDocument,
  window: SimulatorWindow,
): void {
  const messages: SimulatorMessage[] = []
  const conversationId = createId("conversation")
  const nodes = new Map<string, { element: SimulatorElement, html: string }>()
  let busy = false
  let stick = true
  const embedded = document.documentElement.dataset.embed !== undefined

  const find = (id: string): SimulatorElement => {
    const element = document.getElementById(id)
    if (!element) throw new Error(`The simulator page has no #${id} element.`)
    return element
  }
  const scroller = find("scroll")
  const list = find("list")
  // SAFETY: Every skin renders #input as a textarea.
  const input = find("input") as SimulatorTextArea
  // SAFETY: Every skin renders #form as a form.
  const form = find("form") as SimulatorForm
  const failure = document.createElement("div")
  failure.setAttribute("class", "sim-error")
  failure.setAttribute("role", "alert")
  list.after(failure)

  function createId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  function escape(text: string): string {
    return text.replace(/[&<>"']/g, character => character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === "\"" ? "&quot;" : "&#39;")
  }

  function link(url: string, label: string): string {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
  }

  // Inline Markdown: code, http and https links, bold, and italic. The text is escaped first, and code and links are
  // kept aside under private-use placeholders so that later rules do not change them.
  function inline(text: string): string {
    const kept: string[] = []
    const keep = (html: string): string => `${kept.push(html) - 1}`
    const restore = (html: string): string => html.replace(/(\d+)/g, (_, index: string) => restore(kept[Number(index)] ?? ""))
    return restore(escape(text.replace(/[]/g, ""))
      .replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`))
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => keep(link(url, label)))
      .replace(/https?:\/\/[^\s<]*[^\s<.,;:!?)]/g, url => keep(link(url, url)))
      .replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_(?=\S)([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>"))
  }

  // Block Markdown: fenced code, blockquotes, lists, and paragraphs. An open fence renders as code while it streams.
  function markdown(source: string): string {
    const lines = source.replace(/\r/g, "").split("\n")
    const blocks: string[] = []
    const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/
    const startsBlock = (line: string): boolean => line.startsWith("```") || line.startsWith(">") || listItem.test(line)
    let index = 0
    while (index < lines.length) {
      const line = lines[index]
      const fence = /^```\s*([\w+-]*)/.exec(line)
      if (fence) {
        const code: string[] = []
        for (index++; index < lines.length && !lines[index].startsWith("```"); index++) code.push(lines[index])
        index++
        blocks.push(`<pre${fence[1] ? ` data-lang="${escape(fence[1])}"` : ""}><code>${escape(code.join("\n"))}</code></pre>`)
      }
      else if (line.startsWith(">")) {
        const quote: string[] = []
        for (; index < lines.length && lines[index].startsWith(">"); index++) quote.push(inline(lines[index].replace(/^>\s?/, "")))
        blocks.push(`<blockquote>${quote.join("<br>")}</blockquote>`)
      }
      else if (listItem.test(line)) {
        const ordered = /^\s*\d/.test(line)
        const items: string[] = []
        for (; index < lines.length && listItem.test(lines[index]); index++) items.push(`<li>${inline(lines[index].replace(listItem, ""))}</li>`)
        blocks.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`)
      }
      else if (!line.trim()) {
        index++
      }
      else {
        const paragraph: string[] = []
        for (; index < lines.length && lines[index].trim() && !startsBlock(lines[index]); index++) paragraph.push(inline(lines[index]))
        blocks.push(`<p>${paragraph.join("<br>")}</p>`)
      }
    }
    return blocks.join("")
  }

  function time(date: Date): string {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  }

  // Renders the messages from `from` to the end. A message depends only on its neighbours and on the messages after it,
  // so a change at the end of the history renders the last three messages only.
  function render(from = 0): void {
    const view: SimulatorView = { busy, config, escape, markdown, messages, time }
    for (let index = Math.max(0, from); index < messages.length; index++) {
      const message = messages[index]
      const html = skin.message(view, index)
      let node = nodes.get(message.id)
      if (!node) {
        node = { element: document.createElement("div"), html: "" }
        nodes.set(message.id, node)
        list.append(node.element)
      }
      if (node.html !== html) {
        node.html = html
        node.element.innerHTML = html
      }
    }
    skin.update(view, document)
    list.setAttribute("aria-busy", String(busy))
    form.setAttribute("aria-busy", String(busy))
    if (stick) scroller.scrollTop = scroller.scrollHeight
  }

  // Yields the JSON parts of a Server-Sent Events body until `data: [DONE]`.
  async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<{ delta?: unknown, errorText?: unknown, type?: unknown }> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "")
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const data = buffer.slice(0, end).split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n")
          buffer = buffer.slice(end + 2)
          if (data === "[DONE]") return
          if (data) yield JSON.parse(data)
        }
      }
    }
    finally {
      await reader.cancel()
    }
  }

  // Shows a failed reply after the messages, with a button that sends the same text again.
  function fail(text: string, reason: string): void {
    const note = document.createElement("span")
    note.textContent = `Could not reach ${config.agent}: ${reason}`
    const retry = document.createElement("button")
    retry.setAttribute("type", "button")
    retry.textContent = "Retry"
    retry.addEventListener("click", () => {
      if (busy) return
      if (input.value.trim() === text) {
        input.value = ""
        grow()
      }
      void send(text)
    })
    failure.innerHTML = ""
    failure.append(note)
    failure.append(retry)
  }

  async function send(text: string): Promise<void> {
    const user: SimulatorMessage = { at: new Date(), id: createId("message"), role: "user", text }
    const reply: SimulatorMessage = { at: new Date(), id: createId("reply"), role: "assistant", text: "" }
    const append = (delta: string): void => {
      if (!messages.includes(reply)) {
        reply.at = new Date()
        messages.push(reply)
      }
      reply.text += delta
      render(messages.length - 3)
    }
    failure.innerHTML = ""
    messages.push(user)
    busy = true
    stick = true
    render(messages.length - 3)
    try {
      const response = await fetch(config.route, {
        body: JSON.stringify({ id: conversationId, messages: [{ id: user.id, parts: [{ text, type: "text" }], role: "user" }] }),
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        method: "POST",
      })
      if (!response.ok || !response.body) throw new Error(`The Channel route answered with HTTP ${response.status}.`)
      for await (const event of events(response.body)) {
        if (event.type === "text-delta" && typeof event.delta === "string") append(event.delta)
        else if (event.type === "error") throw new Error(typeof event.errorText === "string" ? event.errorText : "The Agent stream failed.")
        else if (event.type === "finish") break
      }
    }
    catch (error) {
      // With no reply text, the message did not reach the Agent as far as the page knows, so it goes back to the input.
      if (!messages.includes(reply)) {
        messages.splice(messages.indexOf(user), 1)
        nodes.get(user.id)?.element.remove()
        nodes.delete(user.id)
        if (!input.value.trim()) {
          input.value = text
          grow()
        }
      }
      fail(text, error instanceof Error ? error.message : String(error))
    }
    finally {
      busy = false
      render(messages.length - 3)
      if (embedded) window.parent.postMessage({ type: "vitehub:channel-reply" }, window.location.origin)
    }
  }

  function grow(): void {
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`
  }

  scroller.addEventListener("scroll", () => {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
  })
  input.addEventListener("input", grow)
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
    event.preventDefault()
    form.requestSubmit()
  })
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    const text = input.value.trim()
    if (busy || !text) return
    input.value = ""
    grow()
    void send(text)
  })
  render()
  if (!embedded) input.focus()
}
