// IPC handlers (PrincipleApi) for principle priorities, built by main/index.ts. No electron imports.

import { join } from 'node:path'
import { PrincipleService, type PrincipleGate, type PrincipleMemoryLike } from './service.ts'

export interface PrincipleWireDeps {
  userDataDir: string
  memory?: PrincipleMemoryLike
  emit: (event: 'principles:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  gate?: PrincipleGate
}

export interface PrincipleWiring {
  service: PrincipleService
  handlers: Record<string, (...args: any[]) => unknown>
}

export function createPrincipleWiring(deps: PrincipleWireDeps): PrincipleWiring {
  const service = new PrincipleService({ dir: join(deps.userDataDir, 'principles'), memory: deps.memory, emit: deps.emit, log: deps.log, gate: deps.gate })
  return {
    service,
    handlers: {
      principlesView: () => service.view(),
      principlesReset: () => service.reset()
    }
  }
}
