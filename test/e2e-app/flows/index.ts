// The suite, in run order. Add a flow by appending to one of these lists (or a new file's list):
// flows share one app instance, so later flows may rely on state earlier ones left (the open project,
// the configured fake provider). Keep no-key flows before 'fake-provider'.
import { coreFlows } from './core.ts'
import { pageFlows } from './pages.ts'
import { labFlows } from './labs.ts'
import { studioFlows, syncFlows } from './sync.ts'
import { aiFlows } from './ai.ts'
import { providerQolFlows, qolFlows, webglOffFlows } from './qol.ts'
import type { Flow } from './types.ts'

export type { Flow, FlowCtx } from './types.ts'

export const FLOWS: Flow[] = [...coreFlows, ...syncFlows, ...labFlows, ...studioFlows, ...qolFlows, ...pageFlows, ...aiFlows, ...providerQolFlows, ...webglOffFlows]
