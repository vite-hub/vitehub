import { defineEventHandler } from 'h3'
import { getBabysitterDrainStatus } from '../plugins/babysitter-demand.ts'

export default defineEventHandler(() => ({ status: getBabysitterDrainStatus() }))
