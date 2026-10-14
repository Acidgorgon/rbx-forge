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
    'editor.background': '#1b1b1b',
    'editor.foreground': '#c8c8c8',
    'editorLineNumber.foreground': '#5c5c5c',
    'editorLineNumber.activeForeground': '#a8a8a8',
    'editor.lineHighlightBackground': '#ffffff07',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#6fa8dc33',
    'editor.inactiveSelectionBackground': '#6fa8dc1a',
    'editor.selectionHighlightBackground': '#6fa8dc18',
    'editor.wordHighlightBackground': '#ffffff0d',
    'editor.findMatchBackground': '#e5c07b40',
    'editor.findMatchHighlightBackground': '#e5c07b1e',
    'editorCursor.foreground': '#c8c8c8',
    'editorIndentGuide.background1': '#2a2a2a',
    'editorIndentGuide.activeBackground1': '#3a3a3a',
    'editorWhitespace.foreground': '#333333',
    'editorBracketMatch.background': '#e5c07b14',
    'editorBracketMatch.border': '#e5c07b55',
    'editorWidget.background': '#1e1e1e',
    'editorWidget.border': '#333333',
    'editorHoverWidget.background': '#1e1e1e',
    'editorHoverWidget.border': '#333333',
    'editorSuggestWidget.background': '#1e1e1e',
    'editorSuggestWidget.border': '#333333',
    'editorSuggestWidget.selectedBackground': '#ffffff0f',
    'editorSuggestWidget.highlightForeground': '#e5c07b',
    'list.hoverBackground': '#ffffff0a',
    'editorStickyScroll.background': '#1b1b1b',
    'editorStickyScrollHover.background': '#222222',
    'editorGutter.addedBackground': '#7fa86a',
    'editorGutter.modifiedBackground': '#6fa8dc',
    'editorGutter.deletedBackground': '#d98a9a',
    'editorError.foreground': '#e88fa1',
    'editorWarning.foreground': '#e5c07b',
    'editorInfo.foreground': '#6fa8dc',
    'editorOverviewRuler.errorForeground': '#e88fa1',
    'editorOverviewRuler.warningForeground': '#e5c07b',
    'minimap.background': '#1b1b1b',
    'minimapSlider.background': '#ffffff0c',
    'scrollbarSlider.background': '#ffffff10',
    'scrollbarSlider.hoverBackground': '#ffffff1a',
    'scrollbarSlider.activeBackground': '#ffffff24',
    'diffEditor.insertedTextBackground': '#b5d99c22',
    'diffEditor.removedTextBackground': '#f2a7b522',
    'diffEditor.insertedLineBackground': '#b5d99c0e',
    'diffEditor.removedLineBackground': '#f2a7b50e'
  }
})

monaco.editor.defineTheme('forge-light', {
  base: 'vs',
  inherit: true,
  rules: rules('light'),
  colors: {
    'editor.background': '#fafaf8',
    'editor.foreground': '#2b2b2b',
    'editorLineNumber.foreground': '#a8a8a4',
    'editorLineNumber.activeForeground': '#4a4a4a',
    'editor.lineHighlightBackground': '#00000007',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#2f6aa82a',
    'editor.inactiveSelectionBackground': '#2f6aa816',
    'editorCursor.foreground': '#2b2b2b',
    'editorIndentGuide.background1': '#e6e6e2',
    'editorIndentGuide.activeBackground1': '#cfcfca',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#d8d8d4',
    'editorSuggestWidget.selectedBackground': '#0000000c',
    'editorSuggestWidget.highlightForeground': '#9a6b12',
    'editorStickyScroll.background': '#fafaf8',
    'editorGutter.addedBackground': '#5f8a50',
    'editorGutter.modifiedBackground': '#2f6aa8',
    'editorGutter.deletedBackground': '#b5475d',
    'minimap.background': '#fafaf8',
    'diffEditor.insertedTextBackground': '#5f8a5022',
    'diffEditor.removedTextBackground': '#b5475d22'
  }
})

// Blink (github.com/1Axen/blink) networking IDL, for events.blink: src/shared/blink.
registerBlink(monaco)

// Editor language for a repo path.
export function languageForPath(path: string): string {
  return /\.blink$/i.test(path) ? 'blink' : 'luau'
}

export { monaco }
