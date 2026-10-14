// Registers the Blink language in Monaco: grammar, language configuration, completions and
// hovers, all from the pure modules in src/shared/blink. Compile errors arrive as markers
// from the Blink watcher (CodeEditor.tsx), not from here.
import type * as Monaco from 'monaco-editor'
import { BLINK_LANGUAGE_CONFIGURATION, BLINK_MONARCH } from '@shared/blink/language'
import { blinkCompletions, blinkHover, type BlinkCompletionKind } from '@shared/blink/complete'

export function registerBlink(monaco: typeof Monaco): void {
  monaco.languages.register({ id: 'blink', extensions: ['.blink'], aliases: ['Blink', 'blink'] })
  monaco.languages.setLanguageConfiguration('blink', BLINK_LANGUAGE_CONFIGURATION as Monaco.languages.LanguageConfiguration)
  monaco.languages.setMonarchTokensProvider('blink', BLINK_MONARCH as unknown as Monaco.languages.IMonarchLanguage)

  const K = monaco.languages.CompletionItemKind
  const kinds: Record<BlinkCompletionKind, Monaco.languages.CompletionItemKind> = {
    keyword: K.Keyword,
    field: K.Field,
    value: K.EnumMember,
    type: K.Struct,
    primitive: K.TypeParameter,
    option: K.Property,
    snippet: K.Snippet,
    class: K.Class
  }

  monaco.languages.registerCompletionItemProvider('blink', {
    triggerCharacters: [':', '<', '(', '[', ' '],
    provideCompletionItems(model, position, context) {
      const offset = model.getOffsetAt(position)
      const text = model.getValue()
      // A space only opens the list after `Key:`, `=`, `,` or `option` (From: |, option X = |).
      if (context.triggerCharacter === ' ' && !/(?:[:=,(<]|\boption)\s$/.test(text.slice(Math.max(0, offset - 8), offset))) return { suggestions: [] }
      // Replace the word being typed, dots included (Scope.Type).
      const typed = /[A-Za-z_][\w.]*$/.exec(text.slice(0, offset))?.[0] ?? ''
      const start = model.getPositionAt(offset - typed.length)
      const range = new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column)
      const suggestions = blinkCompletions(text, offset).map((c) => ({
        label: c.label,
        kind: kinds[c.kind],
        insertText: c.insertText,
        insertTextRules: c.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        detail: c.detail,
        documentation: c.documentation ? { value: c.documentation } : undefined,
        sortText: c.sortText,
        range
      }))
      return { suggestions }
    }
  })

  monaco.languages.registerHoverProvider('blink', {
    provideHover(model, position) {
      const h = blinkHover(model.getValue(), model.getOffsetAt(position))
      if (!h) return null
      const a = model.getPositionAt(h.start)
      const b = model.getPositionAt(h.end)
      return { range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column), contents: [{ value: h.markdown }] }
    }
  })
}
