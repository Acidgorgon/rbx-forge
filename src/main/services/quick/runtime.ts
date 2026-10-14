// What src/main/bootstrap.ts tells the app code it loaded (pure; no electron imports). The bootstrap
// is part of the installed app and is never replaced by a quick update, so the key and package
// versions here are the installed app's, whichever code runs.
import type { ShellInfo } from './shellInfo.ts'

export interface ForgeBoot {
  source: 'bundled' | 'quick'
  // Version of the running code (the app version, or <version>-quick.<n>).
  version: string
  // The installed app's version.
  appVersion: string
  // userData/code
  codeRoot: string
  shell: ShellInfo
  publicKey: string
  // Why quick updates cannot be used in this launch (development build, no key), if so.
  unavailable?: string
  // Development test hook (unpackaged build with FORGE_QUICK_DEV=1): the local feed to read.
  devFeed?: string
  // Clears the "booting" marker: call once the window has loaded.
  markBooted(): void
  // Marks the running quick version bad (it falls back to the installed code at the next launch).
  markBad(reason: string): void
}

const KEY = '__forgeBoot'

export function setBootInfo(info: ForgeBoot): void {
  ;(globalThis as Record<string, unknown>)[KEY] = info
}

export function bootInfo(): ForgeBoot | null {
  return ((globalThis as Record<string, unknown>)[KEY] as ForgeBoot | undefined) ?? null
}
