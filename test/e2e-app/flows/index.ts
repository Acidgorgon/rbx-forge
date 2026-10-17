// The suite, in run order. Add a flow by appending to one of these lists (or a new file's list):
// flows share one app instance, so later flows may rely on state earlier ones left (the open project,
// the configured fake provider). Keep no-key flows before 'fake-provider'.
import { coreFlows } from './core.ts'
import { editorAssistFlows } from './editorAssist.ts'
import { editorGroupFlows } from './editorGroups.ts'
import { pageFlows } from './pages.ts'
import { studioMcpFlows } from './studioMcp.ts'
import { artFlows } from './art.ts'
import { labFlows } from './labs.ts'
import { studioFlows, syncFlows } from './sync.ts'
import { aiFlows } from './ai.ts'
import { modelAiFlows, modelFlows } from './model.ts'
import { providerQolFlows, qolFlows, webglOffFlows } from './qol.ts'
import type { Flow } from './types.ts'

export type { Flow, FlowCtx } from './types.ts'

export const FLOWS: Flow[] = [...coreFlows, ...editorAssistFlows, ...editorGroupFlows, ...syncFlows, ...labFlows, ...modelFlows, ...studioFlows, ...qolFlows, ...pageFlows, ...studioMcpFlows, ...artFlows, ...aiFlows, ...modelAiFlows, ...providerQolFlows, ...webglOffFlows]
