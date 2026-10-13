// preview_ui: renders a UI Labs story headless (Lune) and returns a PNG screenshot plus a text
// outline, so an agent can see the UI it builds. Same shape as the other service tools. No electron
// imports: the screenshot comes from deps.capture (an offscreen BrowserWindow in the app).

import { z } from 'zod'
import { outline } from '../../../shared/uiPreview/summary.ts'
import type { UiDevice, UiImageInfo, UiStoryList } from '../../../shared/uiPreviewTypes.ts'
import type { UiTreeSnapshot } from '../../../shared/uiPreview/protocol.ts'
import type { RenderRequest, RenderResult } from './service.ts'

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export type PreviewToolResult = { content: Content[]; isError?: boolean }

export const DEVICE_SIZES: Record<UiDevice, { width: number; height: number }> = {
  phone: { width: 844, height: 390 },
  tablet: { width: 1180, height: 820 },
  desktop: { width: 1920, height: 1080 },
  console: { width: 1920, height: 1080 }
}

export interface PreviewToolDeps {
  render(request: RenderRequest): Promise<RenderResult>
  stories(): Promise<UiStoryList>
  images(refs: string[]): Promise<Record<string, UiImageInfo>>
  // PNG of the snapshot drawn by the app's renderer; null when no window system is available.
  capture?: (input: { tree: UiTreeSnapshot; width: number; height: number; device: UiDevice; images: Record<string, UiImageInfo> }) => Promise<Buffer | null>
  // Puts the PNG in the chat image store and returns its marker, so the user sees it too.
  chatImage?: (png: Buffer, name: string) => Promise<string | null>
}

export const PREVIEW_UI_DESCRIPTION =
  'Render a UI Labs story (*.story.luau: Vide, generic or function stories) headless in Forge and return a PNG screenshot plus an outline of every visible element (path, class, text, pixel rect). story = story file path or name (e.g. "RacingHud"). device phone (844x390) | tablet | desktop (1920x1080, default) | console, or width/height. clicks = element names or paths ("BOOSTButton", "RacingHud.UpgradePanel.Header.Close") to click in order before the screenshot (opens panels, toggles). controls = UI Labs control values by key. Approximate: substitute fonts and text metrics, no ViewportFrame 3D; use Studio for final checks. Call it after building or changing UI to check your work.'

export async function resolveStory(query: string, list: UiStoryList): Promise<string | null> {
  const q = query.trim().replace(/\\/g, '/')
  const all = list.storybooks.flatMap((b) => b.stories)
  const exact = all.find((s) => s.file === q || s.file === q.replace(/^\.\//, ''))
  if (exact) return exact.file
  const lower = q.toLowerCase().replace(/\.story(\.luau?)?$/, '')
  const byName = all.find((s) => s.name.toLowerCase() === lower)
  if (byName) return byName.file
  const partial = all.find((s) => s.file.toLowerCase().includes(lower))
  if (partial) return partial.file
  return /\.story\.luau?$/.test(q) ? q : null
}

export function imageRefs(tree: UiTreeSnapshot): string[] {
  const out = new Set<string>()
  for (const n of tree.nodes) for (const key of ['Image', 'HoverImage', 'PressedImage']) if (typeof n.props[key] === 'string' && n.props[key]) out.add(n.props[key] as string)
  return [...out]
}

export function previewTools(deps: PreviewToolDeps) {
  return [
    {
      name: 'preview_ui',
      description: PREVIEW_UI_DESCRIPTION,
      inputSchema: {
        story: z.string().min(1),
        device: z.enum(['phone', 'tablet', 'desktop', 'console']).optional(),
        width: z.number().int().min(200).max(3840).optional(),
        height: z.number().int().min(200).max(2160).optional(),
        clicks: z.array(z.string()).max(10).optional(),
        controls: z.record(z.string(), z.unknown()).optional()
      },
      handler: async (args: { story: string; device?: UiDevice; width?: number; height?: number; clicks?: string[]; controls?: Record<string, unknown> }): Promise<PreviewToolResult> => {
        const list = await deps.stories()
        const file = await resolveStory(args.story, list)
        if (!file) {
          const names = list.storybooks.flatMap((b) => b.stories.map((s) => s.name)).slice(0, 30)
          return { content: [{ type: 'text', text: `No story matches "${args.story}". Stories: ${names.join(', ') || '(none: add a *.story.luau)'}${list.hint ? `\n${list.hint}` : ''}` }], isError: true }
        }
        const device = args.device ?? 'desktop'
        const size = { width: args.width ?? DEVICE_SIZES[device].width, height: args.height ?? DEVICE_SIZES[device].height }
        const result = await deps.render({ file, ...size, device, ...(args.clicks ? { clicks: args.clicks } : {}), ...(args.controls ? { controls: args.controls } : {}) })
        const lines: string[] = [`${file} (${result.kind ?? 'story'}) at ${size.width}x${size.height} ${device}`]
        if (result.clicked.length) lines.push(`clicked: ${result.clicked.join(', ')}`)
        if (result.missing.length) lines.push(`not found (not clicked): ${result.missing.join(', ')}`)
        const errors = result.console.filter((c) => c.level !== 'print')
        for (const e of errors.slice(0, 6)) lines.push(`${e.level}${e.file ? ` ${e.file}:${e.line}` : ''}: ${e.text.split('\n')[0].slice(0, 300)}`)
        const prints = result.console.filter((c) => c.level === 'print')
        if (prints.length) lines.push(`print: ${prints.slice(-3).map((p) => p.text.slice(0, 120)).join(' | ')}`)
        if (result.error) return { content: [{ type: 'text', text: [...lines, `error: ${result.error}`].join('\n') }], isError: true }
        lines.push('', 'elements (name class "text" @x,y wxh):', ...outline(result.tree, { w: size.width, h: size.height }))
        const content: Content[] = []
        if (deps.capture) {
          try {
            const images = await deps.images(imageRefs(result.tree))
            const png = await deps.capture({ tree: result.tree, ...size, device, images })
            if (png) {
              const marker = deps.chatImage ? await deps.chatImage(png, `${file.split('/').pop()?.replace(/\.luau?$/, '')} preview`).catch(() => null) : null
              if (marker) lines.push('', marker)
              content.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
            } else lines.push('', '(no screenshot: no window system available; outline only)')
          } catch (error) {
            lines.push('', `(screenshot failed: ${(error as Error).message}; outline only)`)
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }, ...content], isError: errors.some((e) => e.level === 'error') && result.tree.nodes.length <= 2 }
      }
    }
  ]
}
