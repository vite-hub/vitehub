import { describe, expect, it } from 'vitest'

import { injectTypeImportsFromImports } from '../src/internal/shared/discovered-definition-typescript'

describe('discovered definition type imports', () => {
  it('injects only missing type imports that are actually referenced', async () => {
    const source = [
      'export type Result = PromiseData<string>',
      '',
      'export const ok = true',
    ].join('\n')

    const injected = await injectTypeImportsFromImports(source, 'fixture.ts', [
      { from: '#imports', name: 'PromiseData', type: true },
      { from: '#imports', name: 'unusedValue' },
    ])

    expect(injected).toContain('import type { PromiseData } from "#imports"')
    expect(injected).not.toContain('unusedValue')
  })
})
