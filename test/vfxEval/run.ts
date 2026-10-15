// npm run eval:vfx: the offline VFX Make benchmark (eval.ts) and the richness benchmark with a fake
// small model (rich.ts), printed as tables. Sequences run when Lune is found (LUNE_PATH or on the
// PATH). No model calls.
import { findLune, findRuntimeDir } from '../../src/main/services/tests/lune.ts'
import { formatReport, runEval } from './eval.ts'
import { formatRichReport, runRichEval } from './rich.ts'

const lune = process.env.LUNE_PATH || findLune()
const runtimeDir = findRuntimeDir()
const report = await runEval({ lune: lune && runtimeDir ? { lune, runtimeDir } : null })
console.log(formatReport(report))
const rich = await runRichEval({ lune: lune && runtimeDir ? { lune, runtimeDir } : null })
console.log(`\n${formatRichReport(rich)}`)
if (process.argv.includes('--json')) console.log(JSON.stringify({ ...report, rich }, null, 1))
