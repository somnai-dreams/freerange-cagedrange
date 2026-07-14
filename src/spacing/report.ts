import {formatDiagnosticPrefix} from '../typescript/diagnostics.ts'
import type {
  SpacingAmount,
  SpacingAxis,
  SpacingCoverageReason,
  SpacingElementAudit,
  SpacingFileAudit,
  SpacingNormalization,
  SpacingOwnershipFinding,
  SpacingReportOptions,
} from './model.ts'

export const spacingPreamble = `Spacing ownership audit. Intrinsic JSX elements are lowered once, then checked for inline offsets without positioning and for Tailwind margin or offset utilities that overlap inline-owned spacing. Coverage limits are reported separately from ownership findings. The audit reads syntax only, checks lowercase intrinsic tags rather than component props, and recognizes an explicit Tailwind spacing dialect.`

const coverageDetailLimit = 20

export function formatSpacingReport(audits: SpacingFileAudit[], options: SpacingReportOptions): string {
  validateNormalization(options.normalization)
  const lines: string[] = [spacingPreamble, '']
  const sorted = [...audits].sort((left, right) => left.file.localeCompare(right.file))
  let visibleInlineElements = 0
  let findingCount = 0
  for (const audit of sorted) {
    for (const element of audit.elements) {
      if (element.hasVisibleInlineOwnership) visibleInlineElements++
      for (const finding of element.ownership) {
        findingCount++
        lines.push(formatOwnershipFinding(audit.file, element, finding, options.pretty))
      }
    }
  }
  if (findingCount === 0) lines.push('No spacing ownership findings.')

  const coverage = formatCoverage(sorted)
  if (coverage.details.length > 0) lines.push('', ...coverage.details)

  const distribution = formatValueDistribution(sorted, options.normalization)
  if (distribution.lines.length > 0) lines.push('', ...distribution.lines)
  const assumptions = formatAssumptions(distribution.assumptions, options.normalization)
  if (assumptions != null) lines.push(assumptions)

  lines.push(
    '',
    `spacing ownership: ${visibleInlineElements} element${visibleInlineElements === 1 ? '' : 's'} with a visible inline margin or offset; ${findingCount} finding${findingCount === 1 ? '' : 's'}.`,
    `coverage: ${coverage.complete}/${coverage.total} intrinsic element${coverage.total === 1 ? '' : 's'} fully scanned; ${coverage.partial} partial; ${coverage.unsupported} unsupported across ${sorted.length} file${sorted.length === 1 ? '' : 's'}.`,
  )
  return lines.join('\n')
}

function validateNormalization(normalization: SpacingNormalization): void {
  if (!Number.isFinite(normalization.tailwindStepRem) || normalization.tailwindStepRem <= 0) {
    throw new Error('Spacing normalization requires a positive finite Tailwind step in rem')
  }
  if (!Number.isFinite(normalization.rootFontSizePx) || normalization.rootFontSizePx <= 0) {
    throw new Error('Spacing normalization requires a positive finite root font size in px')
  }
}

type CoverageReport = {
  complete: number
  partial: number
  unsupported: number
  total: number
  details: string[]
}

function formatCoverage(audits: SpacingFileAudit[]): CoverageReport {
  let complete = 0
  let partial = 0
  let unsupported = 0
  const limitations: string[] = []
  for (const audit of audits) {
    for (const element of audit.elements) {
      const location = `${audit.file}:${element.line}:${element.column}`
      switch (element.coverage.kind) {
        case 'complete': complete++; break
        case 'partial':
          partial++
          limitations.push(`${location} partial — ${element.coverage.reasons.map(coverageReason).join('; ')}`)
          break
        case 'unsupported':
          unsupported++
          limitations.push(`${location} unsupported — ${coverageReason(element.coverage.reason)}`)
          break
      }
    }
  }
  const details: string[] = []
  if (limitations.length > 0) {
    details.push('coverage limits:')
    for (const limitation of limitations.slice(0, coverageDetailLimit)) details.push(`  ${limitation}`)
    if (limitations.length > coverageDetailLimit) {
      details.push(`  +${limitations.length - coverageDetailLimit} more coverage-limited elements`)
    }
  }
  return {complete, partial, unsupported, total: complete + partial + unsupported, details}
}

function coverageReason(reason: SpacingCoverageReason): string {
  switch (reason.kind) {
    case 'spreadAttributes': return 'a props spread may add or replace className or style'
    case 'computedStyle': return 'the style value is computed'
    case 'opaqueStyleMember': return 'the style object contains a spread, method, accessor, or computed property name'
    case 'computedClassName': return 'className is computed and has no statically visible spacing utility'
    case 'partialClassName': return 'className is partly computed; visible spacing utilities were checked'
    case 'computedPosition': return 'the inline position value is computed'
  }
}

type ValueTally = {
  amount: SpacingAmount
  count: number
  sites: string[]
}

type UsedAssumptions = {tailwindStep: boolean; rootFontSize: boolean}

function formatValueDistribution(
  audits: SpacingFileAudit[],
  normalization: SpacingNormalization,
): {lines: string[]; assumptions: UsedAssumptions} {
  const groups = new Map<string, Map<string, ValueTally>>()
  const assumptions: UsedAssumptions = {tailwindStep: false, rootFontSize: false}
  for (const audit of audits) {
    for (const element of audit.elements) {
      for (const value of element.values) {
        noteAssumptions(value.amount, assumptions)
        const axes: SpacingAxis[] = value.axis === 'both' ? ['vertical', 'horizontal'] : [value.axis]
        for (const axis of axes) {
          const groupKey = `${axis} ${value.kind}`
          let group = groups.get(groupKey)
          if (group == null) {
            group = new Map()
            groups.set(groupKey, group)
          }
          const amountKey = formatAmount(value.amount, normalization)
          let tally = group.get(amountKey)
          if (tally == null) {
            tally = {amount: value.amount, count: 0, sites: []}
            group.set(amountKey, tally)
          }
          tally.count++
          if (tally.sites.length < 2) tally.sites.push(`${audit.file}:${element.line}:${element.column}`)
        }
      }
    }
  }
  if (groups.size === 0) return {lines: [], assumptions}

  const lines = ['spacing values (named values are computed in TypeScript):']
  const groupOrder = [
    'vertical margin', 'horizontal margin',
    'vertical padding', 'horizontal padding',
    'vertical gap', 'horizontal gap',
  ]
  for (const groupKey of groupOrder) {
    const group = groups.get(groupKey)
    if (group == null) continue
    const tallies = [...group.values()].sort((left, right) => compareTallies(left, right, normalization))
    const shown = tallies.slice(0, 12)
    const parts = shown.map(tally => {
      const site = tally.count <= 2 ? ` (${tally.sites.join(', ')})` : ''
      return `${formatAmount(tally.amount, normalization)} ×${tally.count}${site}`
    })
    const remaining = tallies.slice(12)
    const commonRemaining = remaining.filter(tally => tally.count > 2).length
    lines.push(`  ${groupKey}: ${parts.join(' · ')}${commonRemaining > 0 ? ` · ${commonRemaining} more` : ''}`)
    const rare = remaining.filter(tally => tally.count <= 2)
    if (rare.length > 0) {
      const shownRare = rare.slice(0, 8)
      const rareParts = shownRare.map(tally =>
        `${formatAmount(tally.amount, normalization)}${tally.count === 2 ? ' ×2' : ''} (${tally.sites[0]!})`)
      const moreRare = rare.length - shownRare.length
      lines.push(`    rare: ${rareParts.join(' · ')}${moreRare > 0 ? ` · +${moreRare} more` : ''}`)
    }
  }
  return {lines, assumptions}
}

function noteAssumptions(amount: SpacingAmount, assumptions: UsedAssumptions): void {
  switch (amount.form) {
    case 'tailwindScale':
      assumptions.tailwindStep = true
      assumptions.rootFontSize = true
      break
    case 'length':
      if (amount.unit === 'rem') assumptions.rootFontSize = true
      break
    case 'named':
    case 'keyword':
    case 'computed': break
  }
}

function formatAssumptions(
  assumptions: UsedAssumptions,
  normalization: SpacingNormalization,
): string | null {
  const parts: string[] = []
  if (assumptions.tailwindStep) parts.push(`Tailwind numeric spacing step = ${formatNumber(normalization.tailwindStepRem)}rem`)
  if (assumptions.rootFontSize) parts.push(`root font size = ${formatNumber(normalization.rootFontSizePx)}px`)
  return parts.length === 0 ? null : `  assumptions: ${parts.join('; ')}.`
}

function compareTallies(
  left: ValueTally,
  right: ValueTally,
  normalization: SpacingNormalization,
): number {
  if (left.count !== right.count) return right.count - left.count
  const leftPixels = normalizedPixels(left.amount, normalization) ?? Infinity
  const rightPixels = normalizedPixels(right.amount, normalization) ?? Infinity
  if (leftPixels !== rightPixels) return leftPixels - rightPixels
  return formatAmount(left.amount, normalization).localeCompare(formatAmount(right.amount, normalization))
}

function formatAmount(amount: SpacingAmount, normalization: SpacingNormalization): string {
  const pixels = normalizedPixels(amount, normalization)
  if (pixels != null) return `${formatNumber(pixels)}px`
  switch (amount.form) {
    case 'tailwindScale': throw new Error('Tailwind scale amount must normalize to pixels')
    case 'length': throw new Error('Length amount must normalize to pixels')
    case 'named': return amount.name
    case 'keyword': return `'${amount.text}'`
    case 'computed': return '(computed)'
  }
}

function normalizedPixels(amount: SpacingAmount, normalization: SpacingNormalization): number | null {
  switch (amount.form) {
    case 'tailwindScale': return amount.steps * normalization.tailwindStepRem * normalization.rootFontSizePx
    case 'length': return amount.unit === 'px' ? amount.value : amount.value * normalization.rootFontSizePx
    case 'named':
    case 'keyword':
    case 'computed': return null
  }
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(6)))
}

function formatOwnershipFinding(
  file: string,
  element: SpacingElementAudit,
  finding: SpacingOwnershipFinding,
  pretty: boolean,
): string {
  const prefix = (rule: string): string =>
    formatDiagnosticPrefix({file, line: element.line, column: element.column}, 'warning', rule, pretty)
  switch (finding.kind) {
    case 'offsetWithoutPosition':
      return `${prefix('spacing-no-position')}inline style sets ${finding.styleProperty} but the element is ${finding.positionClass == null ? 'not positioned (no absolute, fixed, relative, or sticky)' : `'${finding.positionClass}'`}, so the offset has no effect`
    case 'marginClassOnOwnedAxis':
      return `${prefix('spacing-mixed-margin')}class '${finding.className}' adds a ${finding.axis} margin to an element whose inline style already sets ${finding.styleProperty}; two spacing systems move the element on the same axis`
    case 'offsetClassOnOwnedProperty':
      return `${prefix('spacing-mixed-offset')}class '${finding.className}' and the inline style both set ${finding.property}; one of the two silently wins`
  }
}
