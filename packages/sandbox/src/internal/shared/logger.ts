import { consola } from 'consola'

export function createFeatureLogger(tag: string) {
  return consola.withTag(tag)
}
