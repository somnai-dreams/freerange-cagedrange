// Six commands. `fr` checks the project for warnings and errors; `fr --audit` prints
// every function's contracts and refactoring suggestions; `fr --spacing` scans JSX for
// spacing-ownership findings; `fr --state-geometry` scans conditional classNames for
// geometry that varies with state; `fr --layout` checks source-linked intrinsic block-size
// contracts; `fr --breakpoints` derives the viewport thresholds the class tokens declare.
// The first four take an optional file that narrows the output to that file.
// Layout takes an optional config path and is a CI gate. Audit mode is informational and
// fails only on TypeScript errors. Spacing and state-geometry modes read syntax only, so
// they never type-check and never fail.
import {runFileAudit, runFileFindings, runFileSpacing, runFileStateGeometry, runProjectAudit, runProjectBreakpoints, runProjectFindings, runProjectSpacing, runProjectStateGeometry} from './src/project.ts'
import {runProjectLayout} from './src/layout/project.ts'
import {formatTypeScriptDiagnostics, TypeScriptDiagnosticsError} from './src/typescript/diagnostics.ts'

const arguments_ = process.argv.slice(2)
try {
  let failed: boolean
  if (arguments_[0] === '--audit') {
    if (arguments_.length > 2) throw new Error('Usage: fr --audit [file]')
    failed = arguments_.length === 1
      ? runProjectAudit(process.cwd())
      : runFileAudit(arguments_[1]!)
  } else if (arguments_[0] === '--spacing') {
    if (arguments_.length > 2) throw new Error('Usage: fr --spacing [file]')
    failed = arguments_.length === 1
      ? runProjectSpacing(process.cwd())
      : runFileSpacing(arguments_[1]!)
  } else if (arguments_[0] === '--state-geometry') {
    if (arguments_.length > 2) throw new Error('Usage: fr --state-geometry [file]')
    failed = arguments_.length === 1
      ? runProjectStateGeometry(process.cwd())
      : runFileStateGeometry(arguments_[1]!)
  } else if (arguments_[0] === '--breakpoints') {
    if (arguments_.length > 1) throw new Error('Usage: fr --breakpoints')
    failed = runProjectBreakpoints(process.cwd())
  } else if (arguments_[0] === '--layout') {
    if (arguments_.length > 2) throw new Error('Usage: fr --layout [config]')
    failed = runProjectLayout(process.cwd(), arguments_[1])
  } else {
    if (arguments_.length > 1) throw new Error('Usage: fr [file]')
    failed = arguments_.length === 0
      ? runProjectFindings(process.cwd())
      : runFileFindings(arguments_[0]!)
  }
  if (failed) process.exitCode = 1
} catch (error) {
  if (error instanceof TypeScriptDiagnosticsError) {
    console.error(formatTypeScriptDiagnostics(error.diagnostics, error.options, error.currentDirectory).trimEnd())
  } else {
    console.error(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
}
