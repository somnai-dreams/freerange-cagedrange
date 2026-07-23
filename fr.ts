// `fr` checks the project for warnings and errors; `fr --all` runs every project check and
// ends in a manifest naming what ran and what was skipped; `fr --audit` prints every
// function's contracts and refactoring suggestions; `fr --spacing` scans JSX for
// spacing-ownership findings; `fr --state-geometry` scans conditional classNames and style
// attributes for geometry that varies with state; `fr --layout` checks source-linked
// intrinsic block-size contracts; `fr --breakpoints` derives the viewport thresholds the
// class tokens declare. Findings, audit, spacing, and state-geometry take an optional file
// that narrows the output to that file. Layout takes an optional config path and is a CI
// gate. Audit mode is informational and fails only on TypeScript errors. Spacing and
// state-geometry modes read syntax only, so they never type-check and never fail.
import {runFileAudit, runFileFindings, runFileSpacing, runFileStateGeometry, runProjectAll, runProjectAudit, runProjectBreakpoints, runProjectFindings, runProjectSpacing, runProjectStateGeometry} from './src/project.ts'
import {runProjectLayout} from './src/layout/project.ts'
import {formatTypeScriptDiagnostics, TypeScriptDiagnosticsError} from './src/typescript/diagnostics.ts'

const usage = `fr — freerange project checks
  fr [file]                         findings: warnings and errors (gating)
  fr --all                          every project check below, with a ran/skipped manifest
  fr --audit [file]                 numeric contracts per function (informational)
  fr --spacing [file]               spacing-ownership scan (advisory)
  fr --state-geometry [file] [--json]  state-conditional geometry in classNames and styles (advisory)
  fr --breakpoints [--json]         viewport thresholds the class tokens declare
  fr --layout [config]              source-linked layout contracts (gating)`

const rawArguments = process.argv.slice(2)
// --json is recognized by the scans that tooling diffs across worktrees; everywhere else it is a
// loud error rather than a silently ignored flag.
const json = rawArguments.includes('--json')
const arguments_ = rawArguments.filter(argument => argument !== '--json')
const knownFlags = new Set(['--all', '--audit', '--spacing', '--state-geometry', '--breakpoints', '--layout'])
try {
  let failed: boolean
  if (arguments_[0] === '--help' || arguments_[0] === '-h') {
    console.log(usage)
    process.exit(0)
  }
  // A mistyped flag must never fall through to file-findings mode and die as "file not found".
  if (arguments_[0]?.startsWith('-') && !knownFlags.has(arguments_[0])) {
    throw new Error(`Unknown flag '${arguments_[0]}'.\n${usage}`)
  }
  if (json && arguments_[0] !== '--state-geometry' && arguments_[0] !== '--breakpoints') {
    throw new Error('--json is supported for --state-geometry and --breakpoints only.')
  }
  if (arguments_[0] === '--all') {
    if (arguments_.length > 1) throw new Error('Usage: fr --all')
    process.exitCode = runProjectAll(process.cwd()) ? 1 : 0
    process.exit()
  }
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
    if (arguments_.length > 2) throw new Error('Usage: fr --state-geometry [file] [--json]')
    failed = arguments_.length === 1
      ? runProjectStateGeometry(process.cwd(), json)
      : runFileStateGeometry(arguments_[1]!, json)
  } else if (arguments_[0] === '--breakpoints') {
    if (arguments_.length > 1) throw new Error('Usage: fr --breakpoints [--json]')
    failed = runProjectBreakpoints(process.cwd(), json)
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
