import { expect, it } from 'vitest'
import { createAgentConsoleDelivery } from '../src/server/console-delivery.ts'

it('requires a complete optional console configuration', () => {
  expect(createAgentConsoleDelivery({})).toBeUndefined()
  expect(() => createAgentConsoleDelivery({ url: 'https://console.example' })).toThrow('both')
  expect(() => createAgentConsoleDelivery({ token: 'token' })).toThrow('both')
  expect(() => createAgentConsoleDelivery({ url: 'file:///tmp/token', token: 'token' })).toThrow('HTTP(S)')
  const client = createAgentConsoleDelivery({ url: 'https://console.example', token: { unseal: () => 'token' } })!
  expect(client.endpoint('/api/otlp')).toBe('https://console.example/api/otlp')
  expect(client.headers()).toEqual({ authorization: 'Bearer token' })
})
