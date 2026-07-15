import { createEmail } from "./client.ts"

import type { EmailClient, EmailDriver, EmailDriverResult, EmailMessage } from "./types.ts"

export interface MemoryEmailDriver extends EmailDriver {
  clear: () => void
  readonly messages: EmailMessage[]
}

export interface TestEmailClient extends EmailClient {
  clear: () => void
  readonly messages: EmailMessage[]
}

export function createMemoryEmailDriver(): MemoryEmailDriver {
  const messages: EmailMessage[] = []
  let nextId = 1

  return {
    name: "memory",
    messages,
    clear(): void {
      messages.splice(0)
      nextId = 1
    },
    async send(message: EmailMessage): Promise<EmailDriverResult> {
      messages.push(structuredClone(message))
      return { id: `memory-${nextId++}` }
    },
  }
}

export function createTestEmail(): TestEmailClient {
  const driver = createMemoryEmailDriver()
  const client = createEmail({ driver })
  return {
    clear: driver.clear,
    messages: driver.messages,
    send: client.send,
  }
}
