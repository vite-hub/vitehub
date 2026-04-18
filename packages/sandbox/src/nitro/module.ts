import type {} from '../nitro-config'
import { createFeatureNitroModule } from '../internal/shared/vite'
import { sandboxFeatureEngine } from '../integration'
import type { NitroModule } from 'nitro/types'

const sandboxNitroModule: NitroModule = createFeatureNitroModule(sandboxFeatureEngine)

export default sandboxNitroModule
