// Autosave (Settings > Editor): Off, After delay (1 s after the last edit) or On focus change (the
// default, like VS Code's files.autoSave = onFocusChange: switching tabs, the editor losing focus,
// the window losing focus). Autosaves go through store.saveFile like Ctrl+S, so the same write path
// (and Forge Sync's disk-vs-Studio reconcile) applies; a file with a held Studio / Forge Sync conflict
// is never autosaved. Format on save does not run on autosave unless "Format on autosave" is on.
import { useEffect, useRef } from 'react'
import type * as Monaco from 'monaco-editor'
import { DEFAULT_EDITOR_ASSIST } from '@shared/editorAssist/types'
import { shouldAutoSave, type AutoSaveTrigger } from '@shared/editorAssist/policy'
import { useStore } from '../store'
import { useEditorAssist } from './state'

export function useAutoSave(editor: Monaco.editor.IStandaloneCodeEditor | null, path: string): void {
  const { state, actions } = useStore()
  const assist = useEditorAssist()
  const mode = assist?.settings.autoSave ?? DEFAULT_EDITOR_ASSIST.autoSave
  const delay = assist?.settings.autoSaveDelayMs ?? DEFAULT_EDITOR_ASSIST.autoSaveDelayMs
  const live = useRef({ state, actions, mode, path })
  live.current = { state, actions, mode, path }

  const trySave = (p: string, trigger: AutoSaveTrigger) => {
    const { state: s, actions: a, mode: m } = live.current
    const f = s.files.find((x) => x.path === p)
    if (!f) return
    const conflicted = s.studioConflicts.some((c) => c.path === p)
    if (shouldAutoSave(m, trigger, { path: p, dirty: f.current !== f.saved, loading: f.loading, conflicted })) void a.saveFile(p, { reason: 'auto' })
  }

  // Switching tabs saves the file that was showing.
  const shown = useRef(path)
  useEffect(() => {
    const before = shown.current
    shown.current = path
    if (before && before !== path) trySave(before, 'tabSwitch')
  }, [path])

  // The editor losing focus (explorer, palette, chat, a page tab). Widgets inside the editor (find,
  // suggestions, the quick-fix menu) keep focus within it.
  useEffect(() => {
    if (!editor) return
    const sub = editor.onDidBlurEditorWidget(() => trySave(live.current.path, 'editorBlur'))
    return () => sub.dispose()
  }, [editor])

  // The window losing focus (alt-tab to Studio): every open file with changes.
  useEffect(() => {
    const onBlur = () => {
      for (const f of live.current.state.files) trySave(f.path, 'windowBlur')
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  // After delay: once edits pause (every edit replaces state.files), every file with changes. In the
  // other modes the effect has nothing to restart, so it does not depend on the files at all
  // (otherwise it re-ran, and walked every open file, on each keystroke).
  const timed = mode === 'afterDelay'
  const anyDirty = timed && state.files.some((f) => f.current !== f.saved)
  const files = timed ? state.files : null
  useEffect(() => {
    if (!timed || !anyDirty) return
    const t = setTimeout(() => {
      for (const f of live.current.state.files) trySave(f.path, 'delay')
    }, delay)
    return () => clearTimeout(t)
  }, [files, timed, anyDirty, delay])
}
