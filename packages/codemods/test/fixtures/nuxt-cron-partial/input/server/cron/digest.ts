export default defineCronHandler('weekly', async () => {
  console.log('digest')
}, { timeZone: 'Europe/Madrid', runOnInit: true })
