// Shared types for StudioTurnLock (fair FIFO serialization across live Roblox Studio turns).

export interface StudioLockHolder {
  owner: string
  reason: string
  acquiredAt: number
  expiresAt: number
}

export interface StudioLockWaiter {
  owner: string
  reason: string
  queuedAt: number
}

export interface StudioLockStatus {
  holder: StudioLockHolder | null
  queue: StudioLockWaiter[]
}

export interface StudioLockEvents {
  'studioLock:status': StudioLockStatus
}

export interface StudioLockApi {
  studioLockStatus(): Promise<StudioLockStatus>
  studioLockForceRelease(reason?: string): Promise<boolean>
}
