// Command lines for `codex exec` (non-interactive mode). No electron imports.
//
// Flags (learn.chatgpt.com/codex/developer-commands, codex-rs/exec/src/cli.rs and
// codex-rs/utils/cli/src/shared_options.rs, Oct 2026):
//   --json                    JSONL events on stdout (exec_events.rs: thread.started, turn.*, item.*, error)
//   --color never             no ANSI in what little is printed besides the events
//   --sandbox, -s             read-only | workspace-write | danger-full-access (exec defaults to read-only)
//   --cd, -C                  the agent's working root
//   --model, -m               model override (else the user's Codex config)
//   --skip-git-repo-check     allow a folder that is not a git repo
//   --ephemeral               do not persist the session rollout (one-shot calls)
//   --image, -i               images for the prompt; on `exec` it takes 1.. values split on ',', so the
//                             prompt goes after `--` and paths with commas are refused
//   resume <SESSION_ID>       continue a thread (root flags apply to it)
//   PROMPT `-`                read the prompt from stdin (no quoting issues, no length limit)
// exec always runs with approval policy "never" (headless), so nothing waits on a prompt.

export type CodexSandbox = 'read-only' | 'workspace-write'

// The model id Forge shows for "whatever the user's Codex config picks" (no --model).
export const CODEX_DEFAULT_MODEL = 'codex-default'

export interface ExecArgsInput {
  cwd: string
  sandbox: CodexSandbox
  model?: string
  resumeId?: string
  images?: string[]
  ephemeral?: boolean
}

export function buildExecArgs(i: ExecArgsInput): string[] {
  const args = ['exec', '--json', '--color', 'never', '--sandbox', i.sandbox, '--cd', i.cwd, '--skip-git-repo-check']
  const model = i.model?.trim()
  if (model && model !== CODEX_DEFAULT_MODEL) args.push('--model', model)
  if (i.ephemeral) args.push('--ephemeral')
  // A resumed thread keeps its id only when the id is a plain UUID-ish token.
  if (i.resumeId && /^[\w-]+$/.test(i.resumeId)) args.push('resume', i.resumeId)
  for (const img of i.images ?? []) {
    if (img.includes(',')) throw new Error(`Codex cannot take an image path with a comma: ${img}`)
    args.push('--image', img)
  }
  args.push('--', '-')
  return args
}

export const LOGIN_STATUS_ARGS = ['login', 'status']
export const LOGIN_ARGS = ['login']
export const LOGOUT_ARGS = ['logout']
export const VERSION_ARGS = ['--version']

// Environment for codex: the tool PATH, minus API keys. OPENAI_API_KEY / CODEX_API_KEY in the
// environment make Codex bill the API instead of the ChatGPT plan (learn.chatgpt.com/codex/
// image-generation, codex non-interactive docs), which is the opposite of what this backend is for.
export function codexEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1' }
  for (const key of Object.keys(env)) {
    if (/^(OPENAI_API_KEY|CODEX_API_KEY)$/i.test(key)) delete env[key]
  }
  return env
}
