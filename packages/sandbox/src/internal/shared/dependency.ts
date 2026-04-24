import { tryResolveModule } from './module-resolve'

export function hasInstalledDependency(
  deps: Record<string, string>,
  dependency: string,
  options?: {
    paths?: string[]
  },
) {
  return Boolean(deps[dependency]) || tryResolveModule(dependency, options).ok
}
