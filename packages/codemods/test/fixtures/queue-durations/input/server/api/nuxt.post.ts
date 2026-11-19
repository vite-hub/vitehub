export default defineEventHandler(async () => {
  const retentionSeconds = 600
  await sendQueue('welcome-email', { email: 'ada@example.com' }, { delaySeconds: 30, retentionSeconds })
})
