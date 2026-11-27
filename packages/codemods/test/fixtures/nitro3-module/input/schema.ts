import * as v from 'valibot'

export default v.object({
  apiSecret: v.pipe(v.string(), v.minLength(16)),
  greeting: v.pipe(v.string(), v.minLength(2)),
  port: v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1)),
})
