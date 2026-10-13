// IPC handlers (UiPreviewApi) and the preview_ui agent tool, built from app pieces passed in by
// main/integrations.ts. No electron imports: the screenshot function comes in as a dependency.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chatImageStore, hasChatImageStore, imageMarker } from '../../agent/chatImages.ts'
import type { UiInput } from '../../../shared/uiPreview/protocol.ts'
import type { UiOpenRequest, UiPreviewEvent } from '../../../shared/uiPreviewTypes.ts'
import { ImageResolver, type FetchLike } from './images.ts'
import { UiPreviewService } from './service.ts'
import { previewTools, type PreviewToolDeps } from './tools.ts'

export interface UiPreviewWireDeps {
  root: () => string | null
  projectFile: () => string | null
  lunePath: () => string | null
  emit: (event: UiPreviewEvent) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  capture?: PreviewToolDeps['capture']
  fetch?: FetchLike
}

export interface UiPreviewWiring {
  service: UiPreviewService
  images: ImageResolver
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => ReturnType<typeof previewTools>
  onProjectOpen(root: string): void
  onProjectClose(): void
  dispose(): void
}

export function exportName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80)
  if (!/\.(svg|json)$/i.test(clean)) throw new Error('exports are .svg or .json files')
  return clean
}

export function createUiPreviewWiring(deps: UiPreviewWireDeps): UiPreviewWiring {
  const service = new UiPreviewService({
    emit: deps.emit,
    log: deps.log,
    lunePath: deps.lunePath,
    projectFile: deps.projectFile
  })
  const images = new ImageResolver({ root: deps.root, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
  const handlers: Record<string, (...args: any[]) => unknown> = {
    uiPreviewStories: () => service.listStories(),
    uiPreviewOpen: (request: UiOpenRequest) => service.open(request),
    uiPreviewClose: () => service.close(),
    uiPreviewInput: (message: UiInput) => service.input(message),
    uiPreviewState: () => service.state(),
    uiPreviewImages: (refs: string[]) => images.resolveAll(Array.isArray(refs) ? refs.map(String) : []),
    uiPreviewSaveExport: async (name: string, contents: string) => {
      const root = deps.root()
      if (!root) throw new Error('No project open')
      const file = exportName(name)
      const dir = join(root, 'art', 'ui-exports')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, file), String(contents ?? ''))
      return `art/ui-exports/${file}`
    }
  }
  const chatImage = async (png: Buffer, name: string): Promise<string | null> => {
    if (!hasChatImageStore()) return null
    const ref = await chatImageStore().add({ dataUrl: `data:image/png;base64,${png.toString('base64')}`, name })
    return imageMarker(ref)
  }
  let tools: ReturnType<typeof previewTools> | null = null
  return {
    service,
    images,
    handlers,
    tools: () =>
      (tools ??= previewTools({
        render: (r) => service.render(r),
        stories: () => service.listStories(),
        images: (refs) => images.resolveAll(refs),
        ...(deps.capture ? { capture: deps.capture } : {}),
        chatImage
      })),
    onProjectOpen(root: string) {
      service.setRoot(root)
      images.clear()
    },
    onProjectClose() {
      service.setRoot(null)
      images.clear()
    },
    dispose() {
      service.close()
    }
  }
}
