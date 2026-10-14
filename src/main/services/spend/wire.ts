// IPC handlers (SpendApi) for the spending cap, and the process-wide gate hookup.

import { join } from 'node:path'
import type { SpendSettings } from '../../../shared/spend/types.ts'
import { setSpendCap } from './gate.ts'
import { fileStore, SpendService, type SpendServiceDeps } from './service.ts'

export function createSpendWiring(deps: { userDataDir: string; emit: SpendServiceDeps['emit']; log?: (text: string) => void; now?: () => number }): { service: SpendService; handlers: Record<string, (...args: any[]) => unknown>; dispose(): Promise<void> } {
  const service = new SpendService({ store: fileStore(join(deps.userDataDir, 'spend.json')), emit: deps.emit, log: deps.log, now: deps.now })
  setSpendCap(service)
  const handlers: Record<string, (...args: any[]) => unknown> = {
    spendState: async () => {
      await service.ready()
      return service.state()
    },
    spendSetSettings: (patch: unknown) => service.setSettings(patch && typeof patch === 'object' ? (patch as Partial<SpendSettings>) : {}),
    spendRaiseToday: (amount?: unknown) => service.raiseToday(typeof amount === 'number' ? amount : undefined),
    spendClearOverride: () => service.clearOverride()
  }
  return {
    service,
    handlers,
    dispose: async () => {
      await service.flush()
      setSpendCap(null)
    }
  }
}
