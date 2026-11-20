export function retryLater(message: { retry: (options: { delaySeconds: number }) => void }) {
  message.retry({ delaySeconds: 60 })
}
