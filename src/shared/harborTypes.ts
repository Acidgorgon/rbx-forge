// Harbor Family Stack types: Current, Ripple, Anchor, Tide, Lighthouse.

export type HarborLibId = 'current' | 'ripple' | 'anchor' | 'tide' | 'lighthouse'

export const HARBOR_LIB_IDS: readonly HarborLibId[] = ['current', 'ripple', 'anchor', 'tide', 'lighthouse']

export interface HarborLibStatus {
  id: HarborLibId
  name: string
  detected: boolean
  enabled?: boolean
  version?: string
  cliPath?: string
  sourcePaths: string[]
  schemaFiles: string[]
  configKey?: string
}

export interface LibsConfigEntry {
  key: string
  value: boolean
  line: number
  libId?: HarborLibId
}

export interface HarborGenerateResult {
  ok: boolean
  lib: HarborLibId
  code: number
  output: string
  ranCli?: string
}

export interface HarborScaffoldResult {
  ok: boolean
  lib: HarborLibId
  created: string[]
  message: string
}

export interface HarborStatus {
  projectRoot: string | null
  libsConfigPath?: string
  libs: Record<HarborLibId, HarborLibStatus>
  toggles: LibsConfigEntry[]
  watcherActive: boolean
  lastGenerate?: {
    lib: HarborLibId
    at: number
    ok: boolean
    output: string
  }
}

export interface HarborEvents {
  'harbor:status': HarborStatus
  'harbor:generated': HarborGenerateResult
}

export interface HarborApi {
  harborStatus(): Promise<HarborStatus>
  harborRefresh(): Promise<HarborStatus>
  harborToggleLib(key: string, enabled: boolean): Promise<HarborStatus>
  harborGenerate(lib: HarborLibId): Promise<HarborGenerateResult>
  harborScaffold(lib: HarborLibId): Promise<HarborScaffoldResult>
}
