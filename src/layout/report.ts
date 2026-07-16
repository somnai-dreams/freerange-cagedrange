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
  return lines.join('\n')
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
        : check.maximumPx != null && check.maximumPx < check.expectedPixels - check.tolerancePx
          ? `is at most ${pixels(check.maximumPx)}`
          : `has a reachable branch requiring at least ${pixels(check.witnessMinimumPx)}`
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
