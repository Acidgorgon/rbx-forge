// Browser-preview mock for editor assist (StyLua format, autosave settings, AI inline completions).
//   ?stylua=missing   ?completions=off
import type { EditorAssistApi, EditorAssistSettings, EditorAssistStatus, HarnessEvents } from '@shared/types'
import { effectiveEditorAssist, normalizeEditorAssist } from '@shared/editorAssist/policy'
import { cleanCompletion } from '@shared/editorAssist/completion'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

export function editorAssistMock(emit: Emit): EditorAssistApi {
  const q = new URLSearchParams(location.search)
  const stylua = q.get('stylua') !== 'missing'
  const ready = q.get('completions') !== 'off'
  let settings: EditorAssistSettings = normalizeEditorAssist(null)
  const status = (): EditorAssistStatus => ({
    settings,
    stylua: stylua ? { found: true, path: '~/.rokit/bin/stylua' } : { found: false },
    completions: ready ? { ready: true, provider: 'openai', model: 'gpt-6-luna', detail: 'OpenAI gpt-6-luna (mock)' } : { ready: false, detail: 'AI completions need an OpenAI or Anthropic API key, or a ChatGPT/Codex sign-in (Settings > Providers).' },
    effective: effectiveEditorAssist(settings, stylua, ready)
  })
  return {
    async editorAssistStatus() {
      return status()
    },
    async editorAssistSetSettings(patch) {
      settings = normalizeEditorAssist({ ...settings, ...patch })
      const s = status()
      emit('editorAssist:status', s)
      return s
    },
    async formatLuau(_path, text) {
      if (!stylua) return { ok: false, missing: true, error: 'StyLua is not installed.' }
      // Stand-in for StyLua: trailing spaces off, one final newline.
      return { ok: true, text: text.replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n') }
    },
    async inlineComplete(req) {
      if (!ready) return { text: '' }
      await new Promise((r) => setTimeout(r, 120))
      const line = req.prefix.slice(req.prefix.lastIndexOf('\n') + 1)
      const raw = /local\s+\w+\s*=\s*$/.test(line) ? 'game:GetService("Players")' : /print\($/.test(line) ? '"hello")' : ''
      return { text: cleanCompletion(raw, { prefix: req.prefix, suffix: req.suffix }) }
    },
    async inlineCompleteCancel() {}
  }
}
