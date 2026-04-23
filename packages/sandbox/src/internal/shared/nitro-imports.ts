import type { Nitro } from 'nitro/types'

type NitroConfigLayer = {
  config?: object | null
}

type NitroWithC12Layers = Nitro & {
  options: Nitro['options'] & {
    _c12?: {
      layers?: NitroConfigLayer[]
    }
  }
}

function hasOwnImportsConfig(layer: NitroConfigLayer | undefined) {
  return Object.prototype.hasOwnProperty.call(layer?.config || {}, 'imports')
}

export function shouldEnableNitroImports(nitro: Nitro) {
  const target = nitro as NitroWithC12Layers
  if (target.options.imports !== false)
    return false

  const layers = target.options._c12?.layers
  if (!Array.isArray(layers) || layers.length === 0)
    return false

  return !layers.slice(1).some(hasOwnImportsConfig)
}

export function ensureNitroImports(nitro: Nitro): Nitro['options']['imports'] {
  const target = nitro as NitroWithC12Layers
  if (shouldEnableNitroImports(target))
    target.options.imports = {}

  return target.options.imports
}
