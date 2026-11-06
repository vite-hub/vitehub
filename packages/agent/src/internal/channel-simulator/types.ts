/**
 * Types of the Channel simulator page. The browser code of the page is real TypeScript that the server embeds with
 * `Function.prototype.toString()`, so it cannot import anything at runtime. The package has no DOM types, so these
 * interfaces describe the small part of the DOM that the page uses.
 */

export interface SimulatorConfig {
  agent: string
  platform: string
  /** The webhook route of the Channel. The page POSTs AI SDK chat requests to it. */
  route: string
  user: string
}

export interface SimulatorMessage {
  at: Date
  id: string
  role: "assistant" | "user"
  text: string
}

export interface SimulatorView {
  /** A chat request is in flight, so the Agent shows as typing. */
  busy: boolean
  config: SimulatorConfig
  escape: (text: string) => string
  markdown: (text: string) => string
  messages: readonly SimulatorMessage[]
  time: (date: Date) => string
}

export interface SimulatorEvent {
  isComposing?: boolean
  key?: string
  shiftKey?: boolean
  preventDefault: () => void
}

export interface SimulatorElement {
  hidden: boolean
  innerHTML: string
  readonly clientHeight: number
  readonly scrollHeight: number
  scrollTop: number
  readonly style: { height: string }
  textContent: string | null
  addEventListener: (type: string, listener: (event: SimulatorEvent) => void) => void
  append: (node: SimulatorElement) => void
  focus: () => void
  setAttribute: (name: string, value: string) => void
}

export interface SimulatorTextArea extends SimulatorElement {
  value: string
}

export interface SimulatorForm extends SimulatorElement {
  requestSubmit: () => void
}

export interface SimulatorDocument {
  title: string
  createElement: (tag: string) => SimulatorElement
  getElementById: (id: string) => SimulatorElement | null
}

/** Returns the HTML of one message. It runs in the browser, so it must not use anything outside its own body. */
export type SimulatorMessageRenderer = (view: SimulatorView, index: number) => string

/** Updates the parts of the page around the messages, such as the typing state. It runs in the browser. */
export type SimulatorUpdate = (view: SimulatorView, document: SimulatorDocument) => void

/**
 * One platform look. `body` runs on the server. `message` and `update` run in the browser.
 *
 * `body` must contain `#scroll` (the scroll container), `#list` (the message list), `#form`, and the `#input` textarea.
 */
export interface SimulatorSkin {
  body: (config: SimulatorConfig) => string
  css: string
  message: SimulatorMessageRenderer
  platform: string
  update: SimulatorUpdate
}
