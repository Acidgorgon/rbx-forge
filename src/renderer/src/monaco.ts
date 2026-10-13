// Local Monaco setup: bundled workers (no CDN), a Luau language and themes
// that match the app palette.
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

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

const darkRules: monaco.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '7d776c', fontStyle: 'italic' },
  { token: 'comment.directive', foreground: '9a8f7c' },
  { token: 'keyword', foreground: 'e0896a' },
  { token: 'keyword.type', foreground: 'd6a35c' },
  { token: 'type', foreground: 'c7b37a' },
  { token: 'predefined', foreground: 'a7b8d6' },
  { token: 'function', foreground: 'dcc9a6' },
  { token: 'string', foreground: 'a9c38a' },
  { token: 'string.escape', foreground: 'cbb37a' },
  { token: 'delimiter.interpolation', foreground: 'e0896a' },
  { token: 'number', foreground: 'c79bd6' },
  { token: 'number.hex', foreground: 'c79bd6' },
  { token: 'operator', foreground: 'b9b3a8' },
  { token: 'identifier', foreground: 'ebe7df' }
]

monaco.editor.defineTheme('harness-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: darkRules,
  colors: {
    'editor.background': '#1f1e1d',
    'editor.foreground': '#ebe7df',
    'editorLineNumber.foreground': '#57534c',
    'editorLineNumber.activeForeground': '#a39d92',
    'editor.lineHighlightBackground': '#2a2927',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#d9775740',
    'editor.inactiveSelectionBackground': '#d9775722',
    'editorCursor.foreground': '#d97757',
    'editorIndentGuide.background1': '#2f2e2b',
    'editorIndentGuide.activeBackground1': '#45423d',
    'editorWidget.background': '#2a2927',
    'editorWidget.border': '#3a3835',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff22',
    'diffEditor.insertedTextBackground': '#7fae6a26',
    'diffEditor.removedTextBackground': '#d9575726',
    'diffEditor.insertedLineBackground': '#7fae6a14',
    'diffEditor.removedLineBackground': '#d9575714'
  }
})

monaco.editor.defineTheme('harness-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8c867a', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b4532f' },
    { token: 'keyword.type', foreground: '9a6a1c' },
    { token: 'type', foreground: '8a6d1f' },
    { token: 'predefined', foreground: '3d5f99' },
    { token: 'function', foreground: '5c4a2e' },
    { token: 'string', foreground: '4f7a2f' },
    { token: 'delimiter.interpolation', foreground: 'b4532f' },
    { token: 'number', foreground: '8650a6' }
  ],
  colors: {
    'editor.background': '#fbfaf7',
    'editor.lineHighlightBackground': '#f2efe8',
    'editor.selectionBackground': '#d9775733',
    'editorCursor.foreground': '#c4633f',
    'editorLineNumber.foreground': '#bcb6aa'
  }
})

export { monaco }
