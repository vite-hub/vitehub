export interface TemplateApp {
  fetch: (path: string, init?: RequestInit) => Promise<Response>
  origin: string
}

export type Flow = "pending" | ((app: TemplateApp) => Promise<void>)

export const flows: Record<string, Record<string, Flow>> = {
  agent: {
    agent: "pending",
    blob: "pending",
    browser: "pending",
    channels: "pending",
    connections: "pending",
    gateways: "pending",
    presets: "pending",
    "rate-limit": "pending",
    shell: "pending",
    source: "pending",
    workspace: "pending",
  },
  dashboard: {
    agent: "pending",
    auth: "pending",
    blob: "pending",
    cache: "pending",
    choices: "pending",
    cms: "pending",
    comments: "pending",
    content: "pending",
    database: "pending",
    device: "pending",
    env: "pending",
    forms: "pending",
    i18n: "pending",
    kv: "pending",
    mcp: "pending",
    observability: "pending",
    "rate-limit": "pending",
    sync: "pending",
    webhooks: "pending",
  },
  jobs: {
    email: "pending",
    forge: "pending",
    "markdown-template": "pending",
    queue: "pending",
    realtime: "pending",
    sandbox: "pending",
    schedule: "pending",
    workflow: "pending",
  },
}
