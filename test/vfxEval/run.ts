// npm run eval:vfx: the offline VFX Make benchmark (eval.ts), printed as a table. Sequences run when
// Lune is found (LUNE_PATH or on the PATH). No model calls.
import { findLune, findRuntimeDir } from '../../src/main/services/tests/lune.ts'
import { formatReport, runEval } from './eval.ts'

const lune = process.env.LUNE_PATH || findLune()
const runtimeDir = findRuntimeDir()
const report = await runEval({ lune: lune && runtimeDir ? { lune, runtimeDir } : null })
console.log(formatReport(report))
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 1))
