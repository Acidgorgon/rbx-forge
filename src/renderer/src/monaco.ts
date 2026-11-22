// Local Monaco setup: bundled workers (no CDN), a Luau language, Blink, and the forge themes.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'
import { semanticTokenRules } from './lsp/semanticTheme'
import { registerBlink } from './blinkLanguage'

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment
  }
}

self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

loader.config({ monaco })

const keywords = [
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue'
]
const typeKeywords = ['type', 'export', 'typeof']
const builtinTypes = [
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'thread', 'buffer', 'vector',
  'Instance', 'Player', 'Model', 'Folder', 'Part', 'Vector3', 'CFrame', 'Color3', 'UDim2', 'RBXScriptConnection'
]
const builtins = ['game', 'workspace', 'script', 'require', 'print', 'warn', 'error', 'pcall', 'xpcall', 'task', 'table', 'math', 'string', 'Enum', 'self', 'ipairs', 'pairs', 'select', 'setmetatable', 'getmetatable', 'tostring', 'tonumber']

monaco.languages.register({ id: 'luau', extensions: ['.luau', '.lua'], aliases: ['Luau', 'luau'] })

monaco.languages.setLanguageConfiguration('luau', {
  comments: { lineComment: '--', blockComment: ['--[[', ']]'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string'] },
    { open: '`', close: '`', notIn: ['string'] }
  ],
  surroundingPairs: [{ open: '{', close: '}' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: '`', close: '`' }],
  indentationRules: {
    increaseIndentPattern: /^\s*((\b(else|function|then|do|repeat)\b((?!\b(end|until)\b).)*)|(\{\s*))$/,
    decreaseIndentPattern: /^\s*((\b(elseif|else|end|until)\b)|(\})|(\)))/
  }
})

monaco.languages.setMonarchTokensProvider('luau', {
  defaultToken: '',
  keywords,
  typeKeywords,
  builtinTypes,
  builtins,
  operators: ['+', '-', '*', '/', '//', '%', '^', '#', '==', '~=', '<=', '>=', '<', '>', '=', '+=', '-=', '*=', '/=', '..', '..=', '...', '->', '?', '|', '&', '::'],
  symbols: /[=><!~?:&|+\-*/^%#.]+/,
  escapes: /\\(?:[abfnrtvz\\"'`{]|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}|\d{1,3})/,
  tokenizer: {
    root: [
      [/--\[(=*)\[/, { token: 'comment', next: '@blockComment.$1' }],
      [/--!.*$/, 'comment.directive'],
      [/--.*$/, 'comment'],
      [/\[(=*)\[/, { token: 'string', next: '@longString.$1' }],
      // `: Type` annotations and `:: Type` casts
      [/(::?)(\s*)([A-Za-z_][\w.]*)(?![\w.]|\s*[("'{])/, ['delimiter', '', 'type']],
      [/(type|export)(\s+)(?=[A-Za-z_])/, ['keyword.type', '']],
      [/[A-Za-z_]\w*(?=\s*\()/, {
        cases: { '@keywords': 'keyword', '@builtins': 'predefined', '@default': 'function' }
      }],
      [/[A-Za-z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@typeKeywords': 'keyword.type',
          '@builtins': 'predefined',
          '@default': 'identifier'
        }
      }],
      [/[{}()[\]]/, '@brackets'],
      [/0[xX][0-9a-fA-F_]+/, 'number.hex'],
      [/0[bB][01_]+/, 'number'],
      [/\d[\d_]*(\.\d[\d_]*)?([eE][-+]?\d+)?/, 'number'],
      [/"/, { token: 'string', next: '@dqString' }],
      [/'/, { token: 'string', next: '@sqString' }],
      [/`/, { token: 'string', next: '@interp' }],
      [/@symbols/, { cases: { '@operators': 'operator', '@default': '' } }],
      [/[;,]/, 'delimiter']
    ],
    blockComment: [
      [/\](=*)\]/, { cases: { '$1==$S2': { token: 'comment', next: '@pop' }, '@default': 'comment' } }],
      [/[^\]]+/, 'comment'],
      [/./, 'comment']
    ],
    longString: [
      [/\](=*)\]/, { cases: { '$1==$S2': { token: 'string', next: '@pop' }, '@default': 'string' } }],
      [/[^\]]+/, 'string'],
      [/./, 'string']
    ],
    dqString: [
      [/[^\\"]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, { token: 'string', next: '@pop' }]
    ],
    sqString: [
      [/[^\\']+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/'/, { token: 'string', next: '@pop' }]
    ],
    interp: [
      [/\{/, { token: 'delimiter.interpolation', next: '@interpExpr' }],
      [/[^\\`{]+/, 'string'],
      [/@escapes/, 'string.escape'],
      [/`/, { token: 'string', next: '@pop' }]
    ],
    interpExpr: [
      [/\}/, { token: 'delimiter.interpolation', next: '@pop' }],
      { include: 'root' }
    ]
  }
} as monaco.languages.IMonarchLanguage)

// Forge themes: calm, low-contrast "terminal" palette (docs/design/reference-terminal-style.png),
// matching the --syn-* tokens in styles.css.
const SYN = {
  dark: { kw: '6fa8dc', fn: 'd6d6d6', str: 'a9c48f', num: 'c5d18a', com: '7a9f6a', glob: '8fb8de', type: 'c8c8c8', prop: 'c8c8c8', op: 'a0a0a0', brk: 'e5c07b', fg: 'c8c8c8' },
  light: { kw: '2f6aa8', fn: '2b2b2b', str: '4f7a33', num: '6f7a1f', com: '5f8a50', glob: '2f6aa8', type: '3a3a3a', prop: '3a3a3a', op: '666666', brk: '9a6b12', fg: '2b2b2b' }
}

// Blink is all declarations, so it gets more hues than Luau: fields, values, primitives and
// type names each read apart (token names: src/shared/blink/language.ts).
const BLINK_SYN = {
  dark: { field: 'c9b6f2', value: 'd9a26f', prim: '5fc4b4', ref: 'e5c07b', decl: 'e5c07b', member: '9cc4e4', option: 'c9b6f2' },
  light: { field: '6b4fb0', value: 'a8551f', prim: '1b7f74', ref: '8a6110', decl: '8a6110', member: '2f5f8a', option: '6b4fb0' }
}

function blinkRules(theme: 'dark' | 'light'): monaco.editor.ITokenThemeRule[] {
  const b = BLINK_SYN[theme]
  const c = SYN[theme]
  return [
    { token: 'keyword.blink', foreground: c.kw },
    { token: 'keyword.field.blink', foreground: b.field },
    { token: 'keyword.option.blink', foreground: b.option },
    { token: 'constant.blink', foreground: b.value },
    { token: 'type.primitive.blink', foreground: b.prim },
    { token: 'type.ref.blink', foreground: b.ref },
    { token: 'type.declaration.blink', foreground: b.decl, fontStyle: 'bold' },
    { token: 'variable.member.blink', foreground: b.member },
    { token: 'identifier.blink', foreground: c.fg },
    { token: 'comment.blink', foreground: c.com, fontStyle: 'italic' },
    { token: 'operator.blink', foreground: c.op }
  ]
}

function rules(theme: 'dark' | 'light'): monaco.editor.ITokenThemeRule[] {
  const c = SYN[theme]
  return [
    { token: '', foreground: c.fg },
    { token: 'comment', foreground: c.com },
    { token: 'comment.directive', foreground: c.com },
    { token: 'keyword', foreground: c.kw },
    { token: 'keyword.type', foreground: c.kw },
    { token: 'type', foreground: c.type },
    { token: 'predefined', foreground: c.glob },
    { token: 'function', foreground: c.fn },
    { token: 'string', foreground: c.str },
    { token: 'string.escape', foreground: c.num },
    { token: 'delimiter.interpolation', foreground: c.brk },
    { token: 'number', foreground: c.num },
    { token: 'number.hex', foreground: c.num },
    { token: 'operator', foreground: c.op },
    { token: 'delimiter', foreground: c.op },
    { token: 'delimiter.bracket', foreground: c.brk },
    { token: 'delimiter.parenthesis', foreground: c.brk },
    { token: 'delimiter.curly', foreground: c.brk },
    { token: 'delimiter.square', foreground: c.brk },
    { token: 'delimiter.angle', foreground: c.brk },
    { token: 'identifier', foreground: c.prop },
    ...semanticTokenRules(theme),
    ...blinkRules(theme)
  ]
}

monaco.editor.defineTheme('forge-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: rules('dark'),
  colors: {
    'editor.background': '#131722',
    'editor.foreground': '#e6edf7',
    'editorLineNumber.foreground': '#4d596f',
    'editorLineNumber.activeForeground': '#b4c0d3',
    'editor.lineHighlightBackground': '#ffffff08',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#4f8ff738',
    'editor.inactiveSelectionBackground': '#4f8ff71c',
    'editor.selectionHighlightBackground': '#4f8ff71a',
    'editor.wordHighlightBackground': '#ffffff0f',
    'editor.findMatchBackground': '#fbbf2440',
    'editor.findMatchHighlightBackground': '#fbbf241e',
    'editorCursor.foreground': '#4f8ff7',
    'editorIndentGuide.background1': '#22283a',
    'editorIndentGuide.activeBackground1': '#36415e',
    'editorWhitespace.foreground': '#2d3548',
    'editorBracketMatch.background': '#4f8ff71c',
    'editorBracketMatch.border': '#4f8ff766',
    'editorWidget.background': '#1a2130',
    'editorWidget.border': '#2d3748',
    'editorHoverWidget.background': '#1a2130',
    'editorHoverWidget.border': '#2d3748',
    'editorSuggestWidget.background': '#1a2130',
    'editorSuggestWidget.border': '#2d3748',
    'editorSuggestWidget.selectedBackground': '#4f8ff726',
    'editorSuggestWidget.highlightForeground': '#7bb0ff',
    'list.hoverBackground': '#ffffff0c',
    'editorStickyScroll.background': '#131722',
    'editorStickyScrollHover.background': '#171d2b',
    'editorGutter.addedBackground': '#34d399',
    'editorGutter.modifiedBackground': '#4f8ff7',
    'editorGutter.deletedBackground': '#f87171',
    'editorError.foreground': '#f87171',
    'editorWarning.foreground': '#fbbf24',
    'editorInfo.foreground': '#38bdf8',
    'editorOverviewRuler.errorForeground': '#f87171',
    'editorOverviewRuler.warningForeground': '#fbbf24',
    'minimap.background': '#10131a',
    'minimapSlider.background': '#ffffff0e',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff1e',
    'scrollbarSlider.activeBackground': '#ffffff2a',
    'diffEditor.insertedTextBackground': '#34d39922',
    'diffEditor.removedTextBackground': '#f8717122',
    'diffEditor.insertedLineBackground': '#34d3990e',
    'diffEditor.removedLineBackground': '#f871710e'
  }
})

monaco.editor.defineTheme('forge-light', {
  base: 'vs',
  inherit: true,
  rules: rules('light'),
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#0f172a',
    'editorLineNumber.foreground': '#94a3b8',
    'editorLineNumber.activeForeground': '#334155',
    'editor.lineHighlightBackground': '#0f172a07',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#2563eb26',
    'editor.inactiveSelectionBackground': '#2563eb14',
    'editorCursor.foreground': '#2563eb',
    'editorIndentGuide.background1': '#e2e8f0',
    'editorIndentGuide.activeBackground1': '#cbd5e1',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#cbd5e1',
    'editorSuggestWidget.selectedBackground': '#2563eb14',
    'editorSuggestWidget.highlightForeground': '#1d4ed8',
    'editorStickyScroll.background': '#ffffff',
    'editorGutter.addedBackground': '#059669',
    'editorGutter.modifiedBackground': '#2563eb',
    'editorGutter.deletedBackground': '#dc2626',
    'minimap.background': '#f7f9fc',
    'diffEditor.insertedTextBackground': '#05966920',
    'diffEditor.removedTextBackground': '#dc262620'
  }
})

// Blink (github.com/1Axen/blink) networking IDL, for events.blink: src/shared/blink.
registerBlink(monaco)

// Editor language for a repo path.
export function languageForPath(path: string): string {
  return /\.blink$/i.test(path) ? 'blink' : 'luau'
}

export { monaco }
