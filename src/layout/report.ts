import {pixels as lineBoxPixels, type LineBoxCheck} from './linebox.ts'
import type {StaticLayoutAudit, StaticLayoutCheck, StaticLayoutUnknownReason} from './model.ts'

export function formatStaticLayoutReport(audit: StaticLayoutAudit): string {
  const failures = audit.checks.filter(check => check.kind === 'fail')
  const unknown = audit.checks.filter(check => check.kind === 'unknown')
  const lines = ['Static intrinsic block-size contracts:']
  if (audit.checks.length === 0) lines.push('  No intrinsic block-size constraints.')
  else {
    lines.push(
      '  assumes: Tailwind default 4px lengths, breakpoints, and border-box preflight; '
        + 'unmodeled CSS rules do not change block geometry',
      ...audit.checks.flatMap(formatStaticCheck),
    )
  }
  lines.push(
    `static layout contracts: ${audit.checks.length - failures.length - unknown.length}/${audit.checks.length} passed; `
      + `${failures.length} failed; ${unknown.length} unknown`,
  )
  if (audit.lineBoxChecks.length > 0) {
    lines.push('Line-box containment:')
    for (const check of audit.lineBoxChecks) lines.push(...formatLineBoxCheck(check))
    const failed = audit.lineBoxChecks.filter(check => check.kind === 'fail').length
    const unresolved = audit.lineBoxChecks.filter(check => check.kind === 'unknown').length
    lines.push(
      `line-box containment: ${audit.lineBoxChecks.length - failed - unresolved}/${audit.lineBoxChecks.length} passed; `
        + `${failed} failed; ${unresolved} unknown`,
    )
  }
  return lines.join('\n')
}

function formatLineBoxCheck(check: LineBoxCheck): string[] {
  switch (check.kind) {
    case 'pass': return [
      `  ${check.claim}: passed [line-box-containment] — box ${lineBoxPixels(check.boxPx)} fits strut `
        + `${lineBoxPixels(check.strutPx)} under vertical-align ${check.verticalAlign}`
        + `${check.note == null ? '' : ` (${check.note})`}`,
    ]
    case 'unknown': return [`  ${check.claim}: unknown [line-box-containment] — ${check.reason}`]
    case 'fail': {
      const lines = [
        `  ${check.claim}: error [line-box-containment]: the inline box presents `
          + `${lineBoxPixels(check.boxPx)} against a ${lineBoxPixels(check.strutPx)} strut under `
          + `vertical-align ${check.verticalAlign} — the line grows whenever it is present`,
      ]
      for (const contribution of check.contributions) lines.push(`    ${contribution}`)
      return lines
    }
  }
}

function formatStaticCheck(check: StaticLayoutCheck): string[] {
  switch (check.kind) {
    case 'pass': {
      const measurement = check.minimumPx === check.maximumPx
        ? pixels(check.minimumPx)
        : `${pixels(check.minimumPx)}–${pixels(check.maximumPx)}`
      return [`  ${check.constraint}: passed [layout-intrinsic-block-size] at ${measurement}`]
    }
    case 'unknown': return [
      `  ${check.constraint}: unknown [layout-source-coverage] — ${formatStaticUnknown(check.reason)}`,
    ]
    case 'fail': {
      const measurement = check.maximumPx != null && check.minimumPx === check.maximumPx
        ? `computes to ${pixels(check.minimumPx)}`
        : check.violation.kind === 'atMost'
          ? `has a reachable branch measuring at most ${pixels(check.violation.pixels)}`
          : `has a reachable branch requiring at least ${pixels(check.violation.pixels)}`
      const lines = [
        `  ${check.constraint}: error [layout-intrinsic-block-size]: ${measurement}; `
          + `expected ${pixels(check.expectedPixels)} ±${pixels(check.tolerancePx)}`,
      ]
      for (const evidence of check.evidence) {
        lines.push(`    ${evidence.description} (${evidence.file}:${evidence.line}:${evidence.column})`)
      }
      return lines
    }
  }
}

function formatStaticUnknown(reason: StaticLayoutUnknownReason): string {
  switch (reason.kind) {
    case 'typescriptProjectMissing': return 'no tsconfig.json was found for the source target'
    case 'sourceFileMissing': return `source file '${reason.file}' does not exist`
    case 'sourceFileOutsideProject': return `source file '${reason.file}' is outside the resolved TypeScript project`
    case 'sourceSuppressesTypeChecking':
      return `source file '${reason.file}' contains @ts-nocheck, @ts-ignore, or @ts-expect-error, so its types cannot be trusted`
    case 'sourceMentionsEval':
      return `source file '${reason.file}' mentions eval, so its bindings and types cannot be trusted`
    case 'sourceMarkerMissing': return `source marker '${reason.marker}' was not found`
    case 'sourceMarkerMatchedMultiple':
      return `source marker '${reason.marker}' matched ${reason.count} intrinsic elements; exactly one is required`
    case 'unsupportedSource': return reason.reasons.length === 0
      ? 'the intrinsic block size could not be bounded exactly'
      : reason.reasons.join('; ')
  }
}

function pixels(value: number): string {
  return `${Number(value.toFixed(3))}px`
}
