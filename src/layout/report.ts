import type {LayoutCheck, LayoutSuiteAudit, LayoutUnknownReason} from './model.ts'

export function formatLayoutReport(audit: LayoutSuiteAudit): string {
  const checks = audit.scenarios.flatMap(scenario => scenario.checks)
  const failures = checks.filter(check => check.kind === 'fail')
  const unknown = checks.filter(check => check.kind === 'unknown')
  const lines = [
    'Rendered layout contracts:',
    ...audit.scenarios.flatMap(scenario => formatScenario(scenario.scenario, scenario.checks)),
  ]
  if (checks.length === 0) lines.push('No layout constraints apply to the configured scenarios.')
  lines.push(
    `layout contracts: ${checks.length - failures.length - unknown.length}/${checks.length} passed; `
      + `${failures.length} failed; ${unknown.length} unknown`,
  )
  return lines.join('\n')
}

function formatScenario(scenario: string, checks: LayoutCheck[]): string[] {
  const visible = checks.filter(check => check.kind !== 'pass')
  if (visible.length === 0) return [`  ${scenario}: all ${checks.length} constraints passed`]
  return visible.flatMap(check => formatCheck(check))
}

function formatCheck(check: LayoutCheck): string[] {
  switch (check.kind) {
    case 'pass': return []
    case 'unknown': return [
      `  ${check.scenario}: unknown [layout-coverage]: ${check.constraint} — ${formatUnknownReason(check.reason)}`,
    ]
    case 'fail': {
      if (check.rule === 'layout-size') {
        const actual = check.measurements[0]!
        const lines = [
          `  ${check.scenario}: error [layout-size]: ${check.constraint} measured ${pixels(actual)}; `
            + `expected ${pixels(check.expected as number)} ±${pixels(check.tolerancePx)} (${signedPixels(check.deltaPx)})`,
        ]
        if (check.contributors.length > 0) {
          const label = check.contributors.length === 1
            ? 'largest in-flow direct child margin box'
            : 'largest in-flow direct child margin boxes'
          lines.push(`    ${label}: ${check.contributors.map(contributor =>
            `${contributor.label} is ${pixels(contributor.outerSize)} (${contributor.selector})`).join('; ')}`)
        }
        return lines
      }
      return [
        `  ${check.scenario}: error [layout-alignment]: ${check.constraint} differs by `
          + `${pixels(check.deltaPx)}; allowed ±${pixels(check.tolerancePx)} `
          + `(${check.measurements.map(pixels).join(', ')})`,
      ]
    }
  }
}

function formatUnknownReason(reason: LayoutUnknownReason): string {
  switch (reason.kind) {
    case 'targetMissing': return `target '${reason.target}' did not render`
    case 'targetMatchedMultiple': return `target '${reason.target}' matched ${reason.count} elements; exactly one is required`
    case 'targetHasNoPrincipalBox': return `target '${reason.target}' has no rendered principal box`
    case 'invalidSelector': return `target '${reason.target}' has invalid selector '${reason.selector}'`
    case 'unsupportedWritingMode':
      return `target '${reason.target}' uses unsupported writing mode '${reason.writingMode}'`
    case 'unstableGeometry': return 'the scenario geometry did not stabilize'
    case 'scenarioFailed': return `the scenario failed: ${reason.message}`
    case 'scenarioMissing': return 'the scenario was not captured'
  }
}

function pixels(value: number): string {
  return `${Number(value.toFixed(3))}px`
}

function signedPixels(value: number): string {
  return `${value >= 0 ? '+' : ''}${pixels(value)}`
}
