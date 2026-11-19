import { sendQueue } from "vite-hub/queue"

const later = { delaySeconds: 300 }

export async function sendLater(email: string) {
  return sendQueue("welcome-email", { email }, later)
}
