import * as v from 'valibot'
export default v.object({
  apiSecret: v.pipe(v.string(), v.minLength(16)),
  allowedOrigins: v.pipe(v.string(), v.transform(s => s.split(','))),
  port: v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1)),
  public: v.object({ apiBase: v.pipe(v.string(), v.url(), v.check(u => u.startsWith('https://'), 'https only')) }),
})
