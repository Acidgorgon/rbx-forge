import type { ElectronApp, Launched, Page, Sandbox } from '../lib/app.ts'
import type { FakeProvider } from '../lib/fakeProvider.ts'

export interface FlowCtx {
  app: ElectronApp
  page: Page
  launched: Launched
  // The temp GenTree project (git repo with a bare "origin" next to it).
  root: string
  sandbox: Sandbox
  fake: FakeProvider
  // Adds a line to the flow's notes in the summary.
  note(message: string): void
  // Saves out/shots/<flow>-<name>.png and returns its path.
  shot(name: string): Promise<string>
}

export interface Flow {
  // Short id (used by --only and in file names).
  name: string
  title: string
  timeoutMs?: number
  // 'bridgePort': needs 127.0.0.1:34877 free (the app's Forge Bridge); skipped otherwise.
  needs?: 'bridgePort'[]
  // Console errors this flow is expected to produce (e.g. a deliberately failing AI call).
  allowErrors?: RegExp[]
  run(ctx: FlowCtx): Promise<void>
}
