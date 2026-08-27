import { defineEventHandler } from 'h3'
import { getBabysitterDrainStatus } from '../babysitter.reconciler.ts'

export default defineEventHandler(() => ({ status: getBabysitterDrainStatus() }))
