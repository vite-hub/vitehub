export default defineEventHandler(async () => {
  const retentionSeconds = 600
  await sendQueue('welcome-email', { email: 'ada@example.com' }, { delay: '30s', retention: retentionSeconds })
})
