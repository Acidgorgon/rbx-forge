// Studio errors Forge recognises in any Forge Bridge job and explains with what to do. Studio refuses
// ModuleScript.Source writes from a plugin whose Script Injection permission is off ("Unable to
// assign property Source. Script write access is restricted"); every job builds its modules that
// way, so nothing works until it is turned on. Plain data. No electron imports.

export const SCRIPT_INJECTION_CODE = 'script-injection'

export const SCRIPT_INJECTION_TITLE = 'Studio blocked Forge Bridge from creating scripts'

export const SCRIPT_INJECTION_STEPS = 'In Studio: Plugins tab > Manage Plugins > Forge Bridge > edit (pencil) > turn on Script Injection, then try again.'

export const SCRIPT_INJECTION_MESSAGE = `${SCRIPT_INJECTION_TITLE}. ${SCRIPT_INJECTION_STEPS}`

// The raw Studio texts (and Forge's own message, so a relayed error is recognised again).
const SCRIPT_INJECTION_RE = /Unable to assign property Source|Script write access is restricted|script injection (is )?(not allowed|disabled|denied)|lacks? (the )?permission to (modify|write|create) scripts?|Studio blocked Forge Bridge from creating scripts/i

export function isScriptInjectionError(text: unknown): boolean {
  return typeof text === 'string' && SCRIPT_INJECTION_RE.test(text)
}

// The renderer's toasts: one about this error (whatever job or lab reported it, raw or already
// explained) becomes the one that says what to do, and repeats within gapMs are dropped. Other
// toasts pass unchanged.
export function scriptInjectionToasts(gapMs = 30_000, now: () => number = Date.now) {
  let last = Number.NEGATIVE_INFINITY
  return <T extends { text: string; detail?: string; kind?: string; ms?: number }>(spec: T): T | null => {
    if (!isScriptInjectionError(spec.text) && !isScriptInjectionError(spec.detail)) return spec
    const t = now()
    if (t - last < gapMs) return null
    last = t
    return { ...spec, text: SCRIPT_INJECTION_TITLE, detail: SCRIPT_INJECTION_STEPS, kind: 'err', ms: 15_000 }
  }
}
