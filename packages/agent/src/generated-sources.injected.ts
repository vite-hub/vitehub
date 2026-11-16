// Source text that the Agent Vite plugin writes into generated app modules. It runs in the app without the Agent
// catalog, so its errors are plain. Each message names what the developer changes.

/** The `driver` of the host Agent of a standalone Channel. Its `run()` fails, because the Channel trigger must pick an Agent with a task. */
export function standaloneChannelDriverSource(channel: string): string {
  return `{ run() { throw new Error(${JSON.stringify(`[vitehub] The trigger of Channel "${channel}" must select an Agent with a task.`)}) } }`
}

/** The ChatGPT model provider module of an app without Connections. */
export const chatgptWithoutConnectionsSource = `export function createOpenAI() { throw new Error(${JSON.stringify("[vitehub] The ChatGPT model needs Connections. Enable connections in vitehub() and rebuild.")}) }`
