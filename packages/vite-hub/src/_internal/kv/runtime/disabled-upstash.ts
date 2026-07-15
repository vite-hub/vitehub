export default function disabledUpstashDriver(): never {
  throw new Error("[vitehub] The Upstash KV driver is unavailable because this ViteHub build does not configure an Upstash store.")
}
