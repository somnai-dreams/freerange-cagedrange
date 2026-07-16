import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {
  auditSpacingSource,
  formatSpacingReport,
  type SpacingElementCoverage,
  type SpacingOwnershipFinding,
  type SpacingReportOptions,
  type SpacingValue,
} from '../src/index.ts'

const reportOptions: SpacingReportOptions = {
  pretty: false,
  normalization: {tailwindStepRem: 0.25, rootFontSizePx: 16},
}

// Each scan wraps the element in a component so the fixture is a complete TSX file; the
// scan itself never needs the surrounding code to type-check.
function scanElements(elements: string): {
  inlineSpacedElements: number
  details: SpacingOwnershipFinding[]
  limitedCoverage: SpacingElementCoverage[]
} {
  const source = `export function Fixture(y: number, x: number) {\n  return <main>${elements}</main>\n}\n`
  return scanSource(source)
}

function scanSource(source: string): {
  inlineSpacedElements: number
  details: SpacingOwnershipFinding[]
  limitedCoverage: SpacingElementCoverage[]
} {
  const audit = auditSpacingSource('fixture.tsx', source)
  return {
    inlineSpacedElements: audit.elements.filter(element => element.hasVisibleInlineOwnership).length,
    details: audit.elements.flatMap(element => element.ownership),
    limitedCoverage: audit.elements
      .map(element => element.coverage)
      .filter(coverage => coverage.kind !== 'complete'),
  }
}

test('an absolutely positioned element with an inline offset is clean', () => {
  const {inlineSpacedElements, details} = scanElements('<div className="absolute" style={{top: y}}/>')
  expect(inlineSpacedElements).toBe(1)
  expect(details).toEqual([])
})

test('a literal position style property also satisfies positioning', () => {
  expect(scanElements(`<div style={{position: 'absolute', top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div style={{position: 'fixed', left: x}}/>`).details).toEqual([])
})

test('an inline offset on an element with no CSS position is dead and reported', () => {
  expect(scanElements('<div style={{top: y}}/>').details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
})

test('an unmodeled class makes position absence partial coverage', () => {
  const result = scanElements('<div className="wm-snap-preview" style={{top: y, left: x}}/>')
  expect(result.details).toEqual([])
  expect(result.limitedCoverage).toEqual([{
    kind: 'partial',
    reasons: [{kind: 'unmodeledClass', className: 'wm-snap-preview'}],
  }])

  expect(scanElements(`<div className="wm-snap-preview" style={{position: 'static', top: y}}/>`).details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
})

test('an explicit static class is named in the finding', () => {
  expect(scanElements('<div className="static" style={{top: y}}/>').details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: 'static'},
  ])
})

// From MJ Gallery: a sticky element's inline top is its sticking threshold, and a
// relative element's inline offset is a visual nudge that never moves siblings. Both are
// single-owner patterns, not mixtures.
test('sticky and relative elements accept inline offsets cleanly', () => {
  expect(scanElements('<div className="sticky" style={{top: y}}/>').details).toEqual([])
  expect(scanElements('<div className="relative" style={{left: x}}/>').details).toEqual([])
  expect(scanElements(`<div style={{position: 'sticky', top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div style={{position: 'relative', left: x}}/>`).details).toEqual([])
})

test('a literal position style property overrides position classes', () => {
  expect(scanElements(`<div className="static" style={{position: 'absolute', top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div className="absolute" style={{position: 'static', top: y}}/>`).details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
})

test('a variant-prefixed position class does not satisfy positioning', () => {
  expect(scanElements('<div className="md:absolute" style={{top: y}}/>').details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
})

test('every computed className branch must position the element', () => {
  const noPosition = [{kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null}] satisfies SpacingOwnershipFinding[]
  expect(scanElements(`<div className={open ? 'absolute' : ''} style={{top: y}}/>`).details).toEqual(noPosition)
  expect(scanElements(`<div className={open && 'absolute'} style={{top: y}}/>`).details).toEqual(noPosition)
  expect(scanElements(`<div className={cn({absolute: open})} style={{top: y}}/>`).details).toEqual(noPosition)
  expect(scanElements(`<div className={cn({absolute: false})} style={{top: y}}/>`).details).toEqual(noPosition)
  expect(scanElements(`<div className={open ? 'md:absolute' : 'relative'} style={{top: y}}/>`).details).toEqual(noPosition)

  expect(scanElements(`<div className={open ? 'absolute' : 'relative'} style={{top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div className={cn(open && 'absolute', 'relative')} style={{top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div className={cn({absolute: true})} style={{top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div className={(open && 'absolute') || 'relative'} style={{top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div className={(open ? 'absolute' : '') || 'relative'} style={{top: y}}/>`).details).toEqual([])
})

test('conditional inline offsets are correlated with simple position branches', () => {
  const positionedBranch = scanSource(
    `export function Fixture(open: boolean, y: number) {
      return <div className={open ? 'absolute' : ''} style={{top: open ? y : undefined}}/>
    }`,
  )
  expect(positionedBranch.details).toEqual([])
  expect(positionedBranch.limitedCoverage).toEqual([])

  const unpositionedBranch = scanSource(
    `export function Fixture(open: boolean, y: number) {
      return <div className={open ? 'absolute' : ''} style={{top: open ? undefined : y}}/>
    }`,
  )
  expect(unpositionedBranch.details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
  expect(unpositionedBranch.limitedCoverage).toEqual([])

  const unrelatedConditions = scanSource(
    `export function Fixture(open: boolean, moved: boolean, y: number) {
      return <div className={open ? 'absolute' : ''} style={{top: moved ? y : undefined}}/>
    }`,
  )
  expect(unrelatedConditions.details).toEqual([])
  expect(unrelatedConditions.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'uncorrelatedPositionAndOffset'}]},
  ])

  const exclusiveLiteralValues = scanSource(
    `export function Fixture(mode: string, y: number) {
      return <div className={mode === 'idle' ? '' : 'absolute'} style={{top: mode === 'offset' ? y : undefined}}/>
    }`,
  )
  expect(exclusiveLiteralValues.details).toEqual([])
  expect(exclusiveLiteralValues.limitedCoverage).toEqual([])
})

test('conditional offsets still report when positioning is unconditionally absent', () => {
  const unpositioned = scanElements(`<div style={{top: open ? y : undefined}}/>`)
  expect(unpositioned.details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
  expect(unpositioned.limitedCoverage).toEqual([])

  const positioned = scanElements(`<div className="absolute" style={{top: open ? y : undefined}}/>`)
  expect(positioned.details).toEqual([])
  expect(positioned.limitedCoverage).toEqual([])
})

test('a definitely absent inline offset does not create visible ownership', () => {
  const result = scanElements(`<div style={{top: undefined}}/>`)
  expect(result.inlineSpacedElements).toBe(0)
  expect(result.details).toEqual([])
  expect(result.limitedCoverage).toEqual([])

  const voidResult = scanElements(`<div style={{top: void 0}}/>`)
  expect(voidResult.inlineSpacedElements).toBe(0)
  expect(voidResult.details).toEqual([])
  expect(voidResult.limitedCoverage).toEqual([])
})

test('a shadowed undefined identifier does not masquerade as the global value', () => {
  const audit = auditSpacingSource(
    'fixture.tsx',
    `export function Fixture(undefined: number | undefined) {
      return <div style={{top: undefined}}/>
    }`,
  )
  expect(audit.elements[0]).toMatchObject({
    coverage: {kind: 'partial', reasons: [{kind: 'computedOffsetPresence'}]},
    ownership: [],
    hasVisibleInlineOwnership: true,
  })
})

test('an unsupported offset-presence condition is coverage, not a finding', () => {
  const result = scanElements(`<div style={{top: shouldMove() ? y : undefined}}/>`)
  expect(result.details).toEqual([])
  expect(result.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'computedOffsetPresence'}]},
  ])

  const alwaysPresent = scanElements(`<div style={{top: shouldMove() ? y : fallback}}/>`)
  expect(alwaysPresent.details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
  expect(alwaysPresent.limitedCoverage).toEqual([])

  const alwaysAbsent = scanElements(`<div style={{top: shouldMove() ? null : undefined}}/>`)
  expect(alwaysAbsent.inlineSpacedElements).toBe(0)
  expect(alwaysAbsent.details).toEqual([])
  expect(alwaysAbsent.limitedCoverage).toEqual([])
})

test('mutable and property guards cannot prove correlation across JSX attributes', () => {
  const mutable = scanSource(`export function Fixture(open: boolean, y: number) {
    return <div
      className={open ? 'absolute' : ''}
      data-state={(open = true)}
      style={{top: open ? y : undefined}}
    />
  }`)
  expect(mutable.details).toEqual([])
  expect(mutable.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'uncorrelatedPositionAndOffset'}]},
  ])

  const property = scanSource(`export function Fixture(state: {open: boolean}, y: number) {
    return <div className={state.open ? 'absolute' : ''} style={{top: state.open ? y : undefined}}/>
  }`)
  expect(property.details).toEqual([])
  expect(property.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'uncorrelatedPositionAndOffset'}]},
  ])

  const imported = scanSource(`import {open, toggle} from './state'
  function Other(open: boolean) { return open }
  export const fixture = <div
    className={open ? 'absolute' : ''}
    data-state={toggle()}
    style={{top: open ? undefined : 8}}
  />`)
  expect(imported.details).toEqual([])
  expect(imported.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'uncorrelatedPositionAndOffset'}]},
  ])

  const loopWrite = scanSource(`export function Fixture(open: boolean, values: boolean[]) {
    const toggle = () => {
      for (open of values) break
    }
    return <div
      className={open ? 'absolute' : ''}
      data-state={toggle()}
      style={{top: open ? undefined : 8}}
    />
  }`)
  expect(loopWrite.details).toEqual([])
  expect(loopWrite.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'uncorrelatedPositionAndOffset'}]},
  ])

  const dynamicWrite = scanSource(`export function Fixture(open: boolean, y: number) {
    return <div
      className={open ? 'absolute' : ''}
      data-state={eval('open = true')}
      style={{top: open ? y : undefined}}
    />
  }`)
  expect(dynamicWrite.details).toEqual([])
  expect(dynamicWrite.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'uncorrelatedPositionAndOffset'}]},
  ])
})

test('a later explicit style key replaces the earlier declaration', () => {
  const result = scanSource(`export function Fixture(y: number) {
    return <div
      style={{top: shouldMove() ? y : undefined, top: undefined}}
    />
  }`)
  expect(result.inlineSpacedElements).toBe(0)
  expect(result.details).toEqual([])
  expect(result.limitedCoverage).toEqual([])

  const position = scanSource(`export function Fixture(y: number) {
    return <div style={{position: getPosition(), position: 'absolute', top: y}}/>
  }`)
  expect(position.details).toEqual([])
  expect(position.limitedCoverage).toEqual([])
})

test('MJ Gallery conditional offset patterns are proven or reported as ambiguous', () => {
  const correlated = scanSource(`export function Fixture(type: string, frameHasSidebar: boolean, x: number) {
    return <div
    className={\`\${type === 'style-creator' ? 'shrink-0' : 'absolute'} rounded-xl flex\`}
    style={{left: type !== 'style-creator' && frameHasSidebar ? x : undefined}}
    />
  }`)
  expect(correlated.details).toEqual([])
  expect(correlated.limitedCoverage).toEqual([])

  const correlatedFailure = scanSource(`export function Fixture(type: string, frameHasSidebar: boolean, x: number) {
    return <div
    className={\`\${type === 'style-creator' ? 'absolute' : 'shrink-0'} rounded-xl flex\`}
    style={{left: type !== 'style-creator' && frameHasSidebar ? x : undefined}}
    />
  }`)
  expect(correlatedFailure.details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'left', positionClass: null},
  ])
  expect(correlatedFailure.limitedCoverage).toEqual([])

  const upstreamCorrelation = scanSource(`export function Fixture(type: string, inputFieldLeft: number | undefined) {
    return <div
    className={type === 'style-creator' ? 'shrink-0' : 'absolute'}
    style={{left: inputFieldLeft ?? undefined}}
    />
  }`)
  expect(upstreamCorrelation.details).toEqual([])
  expect(upstreamCorrelation.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'uncorrelatedPositionAndOffset'}]},
  ])
})

test('twMerge positioning follows the last possible position utility', () => {
  expect(scanElements(`<div className={twMerge('absolute', open && 'static')} style={{top: y}}/>`).details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: 'static'},
  ])
  expect(scanElements(`<div className={twMerge('static', 'absolute')} style={{top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div className={twMerge('absolute', 'mt-2')} style={{top: y}}/>`).details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-2'},
  ])
})

test('a shadowable undefined identifier stays unknown', () => {
  const unknown = scanElements(`<div className={undefined || 'absolute'} style={{top: y}}/>`)
  expect(unknown.details).toEqual([])
  expect(unknown.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'partialClassName'}]},
  ])
  expect(scanElements(`<div className={(void 0) || 'absolute'} style={{top: y}}/>`).details).toEqual([])
})

test('nullish coalescing follows reachable conditional branches', () => {
  expect(scanElements(`<div className={(open ? null : 'absolute') ?? 'relative'} style={{top: y}}/>`).details).toEqual([])
  expect(scanElements(`<div className={(open ? '' : 'absolute') ?? 'relative'} style={{top: y}}/>`).details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
  const unknown = scanElements(`<div className={maybeClass ?? 'absolute'} style={{top: y}}/>`)
  expect(unknown.details).toEqual([])
  expect(unknown.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'partialClassName'}]},
  ])
})

test('a margin class on the owned axis is a finding, and the other axis passes', () => {
  expect(scanElements('<div className="absolute mt-4" style={{top: y}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-4'},
  ])
  expect(scanElements('<div className="absolute ml-4" style={{top: y}}/>').details).toEqual([])
  expect(scanElements('<div className="absolute mt-4" style={{left: x}}/>').details).toEqual([])
})

test('shorthand, negative, important, and variant-prefixed margins still match', () => {
  expect(scanElements('<div className="absolute m-2" style={{top: y}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'm-2'},
  ])
  expect(scanElements('<div className="absolute -mt-2" style={{top: y}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: '-mt-2'},
  ])
  expect(scanElements('<div className="absolute !mt-2" style={{top: y}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: '!mt-2'},
  ])
  expect(scanElements('<div className="absolute md:hover:mb-[13px]" style={{bottom: y}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'bottom', className: 'md:hover:mb-[13px]'},
  ])
})

test('an offset class competing with the same inline offset property is a finding', () => {
  expect(scanElements('<div className="absolute top-0" style={{top: y}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'top', styleProperty: 'top', className: 'top-0'},
  ])
})

test('a conditional inline offset still participates in a proven class conflict', () => {
  expect(scanElements(`<div className="absolute top-0" style={{top: open ? y : undefined}}/>`).details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'top', styleProperty: 'top', className: 'top-0'},
  ])
})

// From MJ Gallery: pinning one edge with a class while the inline style sets the
// opposite edge is the standard technique for sizing an absolute element by its edges —
// `left-0` plus inline right, or `bottom-4` plus inline top. The declarations cooperate,
// so only the same property competes.
test('opposite-edge pinning on the same axis is clean', () => {
  expect(scanElements('<div className="absolute left-0" style={{right: x}}/>').details).toEqual([])
  expect(scanElements('<div className="absolute bottom-4" style={{top: y}}/>').details).toEqual([])
})

test('inset classes match by the properties they contain', () => {
  expect(scanElements('<div className="absolute inset-x-0" style={{top: y}}/>').details).toEqual([])
  expect(scanElements('<div className="absolute inset-y-0" style={{top: y}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'top', styleProperty: 'top', className: 'inset-y-0'},
  ])
  expect(scanElements('<div className="absolute inset-0" style={{top: y}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'top', styleProperty: 'top', className: 'inset-0'},
  ])
})

test('logical inset classes match only the corresponding logical edge', () => {
  expect(scanElements('<div className="absolute inset-s-0" style={{top: y, insetInlineStart: x}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'inlineStart', styleProperty: 'insetInlineStart', className: 'inset-s-0'},
  ])
  expect(scanElements('<div className="absolute inset-e-0" style={{top: y, insetInlineEnd: x}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'inlineEnd', styleProperty: 'insetInlineEnd', className: 'inset-e-0'},
  ])
  expect(scanElements('<div className="absolute inset-bs-0" style={{left: x, insetBlockStart: y}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'blockStart', styleProperty: 'insetBlockStart', className: 'inset-bs-0'},
  ])
  expect(scanElements('<div className="absolute inset-be-0" style={{left: x, insetBlockEnd: y}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'blockEnd', styleProperty: 'insetBlockEnd', className: 'inset-be-0'},
  ])
  expect(scanElements('<div dir="rtl" className="absolute inset-s-0" style={{left: x}}/>').details).toEqual([])
})

// From MJ Gallery: `before:` and `[&>*]:` variants style a pseudo-element or other
// elements through a selector, so their spacing never conflicts with this element's
// inline style. Auto margins are alignment, not a spacing amount.
test('pseudo-element variants, selector variants, and auto margins never conflict', () => {
  expect(scanElements('<div className="absolute before:inset-0" style={{top: y}}/>').details).toEqual([])
  expect(scanElements(`<div className="absolute before:top-[calc(100%-2px)]" style={{top: y}}/>`).details).toEqual([])
  expect(scanElements('<div className="absolute [&>*]:mt-2" style={{top: y}}/>').details).toEqual([])
  expect(scanElements('<div className="absolute m-auto" style={{left: x}}/>').details).toEqual([])
  expect(scanElements('<div className="mt-auto" style={{marginBottom: y}}/>').details).toEqual([])
})

// From MJ Gallery: Tailwind v4 marks important with a trailing `!`, and such a class
// beats the inline style, so the conflict is worth reporting with the exact token.
test('trailing-important utilities still match', () => {
  expect(scanElements('<div className="absolute last:mr-0!" style={{marginRight: x}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'horizontal', styleProperty: 'marginRight', className: 'last:mr-0!'},
  ])
  expect(scanElements('<div className="absolute! top-0!" style={{top: y}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'top', styleProperty: 'top', className: 'top-0!'},
  ])
})

test('an inline margin owns its axis without needing positioning', () => {
  expect(scanElements('<div style={{marginTop: y}}/>').details).toEqual([])
  expect(scanElements('<div className="mt-4" style={{marginTop: y}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'marginTop', className: 'mt-4'},
  ])
  // A bottom-margin class shares the vertical axis with an inline top margin: both
  // spacing systems act on the element's vertical rhythm.
  expect(scanElements('<div className="mb-2" style={{marginTop: y}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'marginTop', className: 'mb-2'},
  ])
})

test('a shorthand style property claims its axis', () => {
  const source = 'export function Fixture() {\n  const top = 4\n  return <div style={{top}}/>\n}\n'
  expect(auditSpacingSource('fixture.tsx', source).elements.flatMap(element => element.ownership)).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
})

test('a props spread limits coverage while visible conflicts remain findings', () => {
  const result = scanElements('<div className="mt-4" style={{top: y}} {...({} as object)}/>')
  expect(result.details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-4'},
  ])
  expect(result.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'spreadAttributes'}]},
  ])
})

test('a spread inside the style object limits coverage and suppresses absence-based findings', () => {
  const result = scanElements('<div style={{...({} as object), top: y}}/>')
  expect(result.details).toEqual([])
  expect(result.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'opaqueStyleMember'}]},
  ])
})

test('a later explicit position restores certainty after a style spread', () => {
  const restored = scanElements(`<div style={{...styles, position: 'static', top: y}}/>`)
  expect(restored.details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
  expect(restored.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'opaqueStyleMember'}]},
  ])

  const invalidated = scanElements(`<div style={{position: 'static', ...styles, top: y}}/>`)
  expect(invalidated.details).toEqual([])
  expect(invalidated.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'opaqueStyleMember'}]},
  ])
})

test('a fully computed className limits coverage instead of becoming a finding', () => {
  const result = scanElements('<div className={dynamicClasses} style={{top: y}}/>')
  expect(result.details).toEqual([])
  expect(result.limitedCoverage).toEqual([
    {kind: 'partial', reasons: [{kind: 'computedClassName'}]},
  ])
})

// The extraction reads cn(...)-style calls, templates, ternaries, and && arms, so the
// statically visible classes are checked even when the full list is not knowable. The
// partial note prints after the findings; proving the element unpositioned is the one
// check that stands down, since an unseen class may add `absolute`.
test('classes visible inside cn(...) are checked while the unseen rest limits coverage', () => {
  const first = scanElements(`<div className={cn('absolute mt-2', extra)} style={{top: y}}/>`)
  expect(first.details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-2'},
  ])
  expect(first.limitedCoverage).toEqual([{kind: 'partial', reasons: [{kind: 'partialClassName'}]}])
  const second = scanElements(`<div className={CN('inset-0', props.className)} style={{top: y}}/>`)
  expect(second.details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'top', styleProperty: 'top', className: 'inset-0'},
  ])
  expect(second.limitedCoverage).toEqual([{kind: 'partial', reasons: [{kind: 'partialClassName'}]}])
})

test('conditional classes count like variant-prefixed ones, and full branches stay complete', () => {
  expect(scanElements(`<div className={cond ? 'absolute mt-2' : 'absolute mt-4'} style={{top: y}}/>`).details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-2'},
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-4'},
  ])
  expect(scanElements(`<div className={open && 'mb-2'} style={{marginTop: y}}/>`).details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'marginTop', className: 'mb-2'},
  ])
  expect(scanElements(`<div className={cn({'mt-2': open, absolute: true})} style={{top: y}}/>`).details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-2'},
  ])
})

test('template classes are read; fused fragments are dropped, never guessed', () => {
  const separated = scanElements('<div className={`absolute ${extra}`} style={{top: y}}/>')
  expect(separated.details).toEqual([])
  expect(separated.limitedCoverage).toEqual([{kind: 'partial', reasons: [{kind: 'partialClassName'}]}])
  // `mt-${size}` builds a class the scan cannot name: no mt- token is invented, and
  // with nothing visible the element records computed class coverage.
  const fused = scanElements('<div className={`mt-${size}`} style={{marginTop: y}}/>')
  expect(fused.details).toEqual([])
  expect(fused.limitedCoverage).toEqual([{kind: 'partial', reasons: [{kind: 'computedClassName'}]}])
})

test('extracted class tokens feed the distribution', () => {
  expect(scanValues(`<div className={cn('px-3', extra)}/>`)).toEqual([
    {axis: 'horizontal', kind: 'padding', amount: {form: 'tailwindScale', steps: 3}, source: 'px-3'},
  ])
  expect(scanValues(`<div className={cn({'mt-2': false, 'px-3': true})}/>`)).toEqual([
    {axis: 'horizontal', kind: 'padding', amount: {form: 'tailwindScale', steps: 3}, source: 'px-3'},
  ])
})

test('a computed position value limits coverage and suppresses the no-position finding', () => {
  const source = `export function Fixture(mode: string, y: number) {\n  return <div style={{position: mode, top: y}}/>\n}\n`
  const element = auditSpacingSource('fixture.tsx', source).elements[0]!
  expect(element.ownership).toEqual([])
  expect(element.coverage).toEqual({kind: 'partial', reasons: [{kind: 'computedPosition'}]})
})

test('a literal className expression is still readable', () => {
  expect(scanElements(`<div className={'absolute mt-4'} style={{top: y}}/>`).details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-4'},
  ])
})

test('elements without inline spacing are outside the scan', () => {
  expect(scanElements('<div className="mt-4 gap-2"/>').inlineSpacedElements).toBe(0)
  expect(scanElements('<div style={{width: x}}/>').inlineSpacedElements).toBe(0)
  const reference = scanElements('<div style={someStyle}/>')
  expect(reference.inlineSpacedElements).toBe(0)
  expect(reference.details).toEqual([])
})

test('component elements are skipped; only intrinsic tags scan', () => {
  expect(scanElements('<Card style={{top: y}}/>').inlineSpacedElements).toBe(0)
})

test('the class attribute name works like className', () => {
  expect(scanElements('<div class="absolute mt-1" style={{top: y}}/>').details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-1'},
  ])
})

test('a custom class sharing a utility root is not assumed to be Tailwind', () => {
  const result = scanElements('<div className="absolute top-level-nav" style={{top: y}}/>')
  expect(result.details).toEqual([])
  expect(result.limitedCoverage).toEqual([{
    kind: 'partial',
    reasons: [{kind: 'unmodeledClass', className: 'top-level-nav'}],
  }])
})

test('findings carry the element position and sort by document order', () => {
  const source = [
    'export function Fixture(y: number) {',
    '  return <main>',
    '    <div style={{top: y}}/>',
    '    <span style={{left: y}}/>',
    '  </main>',
    '}',
  ].join('\n')
  const audit = auditSpacingSource('fixture.tsx', source)
  expect(audit.elements.filter(element => element.hasVisibleInlineOwnership)).toHaveLength(2)
  expect(audit.elements.flatMap(element => element.ownership.map(finding => [element.line, finding.kind]))).toEqual([
    [3, 'offsetWithoutPosition'],
    [4, 'offsetWithoutPosition'],
  ])
})

function scanValues(elements: string): SpacingValue[] {
  const source = `export function Fixture(y: number) {\n  return <main>${elements}</main>\n}\n`
  return auditSpacingSource('fixture.tsx', source).elements.flatMap(element => element.values)
}

test('class utilities contribute their amounts on the Tailwind scale', () => {
  expect(scanValues('<div className="mt-2.5"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'tailwindScale', steps: 2.5}, source: 'mt-2.5'},
  ])
  expect(scanValues('<div className="-mt-2"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'tailwindScale', steps: -2}, source: '-mt-2'},
  ])
  expect(scanValues('<div className="mb-px"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'length', value: 1, unit: 'px'}, source: 'mb-px'},
  ])
  expect(scanValues('<div className="p-4"/>')).toEqual([
    {axis: 'both', kind: 'padding', amount: {form: 'tailwindScale', steps: 4}, source: 'p-4'},
  ])
  expect(scanValues('<div className="gap-x-3 space-y-1"/>')).toEqual([
    {axis: 'horizontal', kind: 'gap', amount: {form: 'tailwindScale', steps: 3}, source: 'gap-x-3'},
    {axis: 'vertical', kind: 'gap', amount: {form: 'tailwindScale', steps: 1}, source: 'space-y-1'},
  ])
})

test('space-axis reverse modifiers do not declare spacing amounts', () => {
  expect(scanValues('<div className="space-x-4 rtl:space-x-reverse space-y-2 space-y-reverse"/>')).toEqual([
    {axis: 'horizontal', kind: 'gap', amount: {form: 'tailwindScale', steps: 4}, source: 'space-x-4'},
    {axis: 'vertical', kind: 'gap', amount: {form: 'tailwindScale', steps: 2}, source: 'space-y-2'},
  ])
})

test('arbitrary values parse in px and rem; the rest stay as written', () => {
  expect(scanValues('<div className="mb-[13px]"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'length', value: 13, unit: 'px'}, source: 'mb-[13px]'},
  ])
  expect(scanValues('<div className="m-[0.5rem]"/>')).toEqual([
    {axis: 'both', kind: 'margin', amount: {form: 'length', value: 0.5, unit: 'rem'}, source: 'm-[0.5rem]'},
  ])
  expect(scanValues('<div className="gap-[10%]"/>')).toEqual([
    {axis: 'both', kind: 'gap', amount: {form: 'keyword', text: '10%'}, source: 'gap-[10%]'},
  ])
  expect(scanValues('<div className="mt-[10%] -mt-[10%] mt-[var(--gutter)] -mt-[var(--gutter)]"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'keyword', text: '10%'}, source: 'mt-[10%]'},
    {axis: 'vertical', kind: 'margin', amount: {form: 'keyword', text: '-10%'}, source: '-mt-[10%]'},
    {axis: 'vertical', kind: 'margin', amount: {form: 'keyword', text: 'var(--gutter)'}, source: 'mt-[var(--gutter)]'},
    {axis: 'vertical', kind: 'margin', amount: {form: 'keyword', text: '-var(--gutter)'}, source: '-mt-[var(--gutter)]'},
  ])
  expect(scanValues('<div className="-mt-[-10%] -mt-[+10%]"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'keyword', text: '10%'}, source: '-mt-[-10%]'},
    {axis: 'vertical', kind: 'margin', amount: {form: 'keyword', text: '-10%'}, source: '-mt-[+10%]'},
  ])
})

test('the distribution keeps repeated positive and negative keyword amounts separate', () => {
  const source = [
    'export function Fixture() {',
    '  return <main>',
    '    <div className="mt-[10%]"/>',
    '    <div className="mt-[10%]"/>',
    '    <div className="-mt-[10%]"/>',
    '    <div className="-mt-[10%]"/>',
    '  </main>',
    '}',
  ].join('\n')
  const report = formatSpacingReport([auditSpacingSource('fixture.tsx', source)], reportOptions)
  expect(report).toContain(`'-10%' ×2`)
  expect(report).toContain(`'10%' ×2`)
  expect(report).not.toContain(`'10%' ×4`)
})

test('variant-prefixed amounts are part of the vocabulary; auto margins are not amounts', () => {
  expect(scanValues('<div className="md:hover:mb-2"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'tailwindScale', steps: 2}, source: 'md:hover:mb-2'},
  ])
  expect(scanValues('<div className="mt-auto mx-auto"/>')).toEqual([])
})

test('literal inline styles contribute amounts, names, and computed markers', () => {
  expect(scanValues('<div style={{marginTop: 8, rowGap: -4}}/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'length', value: 8, unit: 'px'}, source: 'marginTop'},
    {axis: 'vertical', kind: 'gap', amount: {form: 'length', value: -4, unit: 'px'}, source: 'rowGap'},
  ])
  expect(scanValues(`<div style={{padding: '12px', columnGap: '0.5rem'}}/>`)).toEqual([
    {axis: 'both', kind: 'padding', amount: {form: 'length', value: 12, unit: 'px'}, source: 'padding'},
    {axis: 'horizontal', kind: 'gap', amount: {form: 'length', value: 0.5, unit: 'rem'}, source: 'columnGap'},
  ])
  expect(scanValues('<div style={{marginRight: y}}/>')).toEqual([
    {axis: 'horizontal', kind: 'margin', amount: {form: 'named', name: 'y'}, source: 'marginRight'},
  ])
  expect(scanValues('<div style={{marginRight: y * 2}}/>')).toEqual([
    {axis: 'horizontal', kind: 'margin', amount: {form: 'computed'}, source: 'marginRight'},
  ])
  expect(scanValues(`<div style={{marginLeft: 'auto', top: y}}/>`)).toEqual([])
})

test('offsets and non-spacing classes stay out of the distribution', () => {
  expect(scanValues('<div className="absolute top-2 w-4 text-sm" style={{left: y}}/>')).toEqual([])
})

test('rare values past the cap print on their own line with locations', () => {
  const divs = Array.from({length: 14}, (_, index) => `<div className="mb-[${101 + index}px]"/>`).join('\n    ')
  const source = `export function Fixture() {\n  return <main>\n    ${divs}\n  </main>\n}\n`
  const report = formatSpacingReport([auditSpacingSource('fixture.tsx', source)], reportOptions)
  expect(report).toContain('101px ×1 (fixture.tsx:3:5)')
  expect(report).toContain('    rare: 113px (fixture.tsx:15:5) · 114px (fixture.tsx:16:5)')
})

test('the report renders the distribution grouped by axis and kind', () => {
  const source = [
    'export function Fixture(gap: number) {',
    '  return <main>',
    '    <div className="mb-2"/>',
    '    <div className="mb-2"/>',
    '    <div className="mb-2"/>',
    '    <div className="mb-2.5"/>',
    '    <div style={{rowGap: gap}}/>',
    '  </main>',
    '}',
  ].join('\n')
  const report = formatSpacingReport([auditSpacingSource('fixture.tsx', source)], reportOptions)
  expect(report).toContain('spacing values (named values are computed in TypeScript):')
  expect(report).toContain('  vertical margin: 8px ×3 · 10px ×1 (fixture.tsx:6:5)')
  expect(report).toContain('  vertical gap: gap ×1 (fixture.tsx:7:5)')
  expect(report).toContain('assumptions: Tailwind numeric spacing step = 0.25rem; root font size = 16px.')
})

test('coverage counts every intrinsic element, including elements with no spacing attributes', () => {
  const audit = auditSpacingSource('fixture.tsx', `export function Fixture() {
  return <><main/><span className={dynamicClasses}/><Card className="mt-2"/></>
}`)
  expect(audit.elements).toHaveLength(2)
  expect(audit.elements.map(element => element.coverage)).toEqual([
    {kind: 'complete'},
    {kind: 'unsupported', reason: {kind: 'computedClassName'}},
  ])
})

test('a computed position without another visible spacing fact is unsupported', () => {
  const audit = auditSpacingSource('fixture.tsx', `export const fixture = <div style={{position: mode}}/>`)
  expect(audit.elements[0]?.coverage).toEqual({kind: 'unsupported', reason: {kind: 'computedPosition'}})
})

test('partial coverage keeps every independent reason and visible ownership finding', () => {
  const result = scanElements(`<div
    className={cn('mt-2', extra)}
    style={{...styles, marginTop: y, position: mode}}
    {...props}
  />`)
  expect(result.details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'marginTop', className: 'mt-2'},
  ])
  expect(result.limitedCoverage).toEqual([{
    kind: 'partial',
    reasons: [
      {kind: 'partialClassName'},
      {kind: 'opaqueStyleMember'},
      {kind: 'computedPosition'},
      {kind: 'spreadAttributes'},
    ],
  }])
})

test('coverage limits are reported separately and do not inflate the finding count', () => {
  const audit = auditSpacingSource(
    'fixture.tsx',
    `export const fixture = <div className={cn('mt-2', extra)} style={{marginTop: 8}}/>`,
  )
  const report = formatSpacingReport([audit], reportOptions)
  expect(report).toContain('warning [spacing-mixed-margin]')
  expect(report).toContain('coverage limits:')
  expect(report).not.toContain('[spacing-unscannable]')
  expect(report).toContain('spacing ownership: 1 element with a visible inline margin or offset; 1 finding.')
  expect(report).toContain('coverage: 0/1 intrinsic element fully scanned; 1 partial; 0 unsupported')
})

test('uncorrelated position and offset conditions print as coverage, not findings', () => {
  const audit = auditSpacingSource(
    'fixture.tsx',
    `export const fixture = <div
      className={open ? 'absolute' : ''}
      style={{top: moved ? 8 : undefined}}
    />`,
  )
  const report = formatSpacingReport([audit], reportOptions)
  expect(report).toContain('No spacing ownership findings.')
  expect(report).toContain(
    'partial — the conditional position and inline offset could not be correlated',
  )
  expect(report).toContain('spacing ownership: 1 element with a visible inline margin or offset; 0 findings.')
  expect(report).toContain('coverage: 0/1 intrinsic element fully scanned; 1 partial; 0 unsupported')
})

test('coverage detail is capped while the aggregate remains exact', () => {
  const elements = Array.from({length: 22}, () => '<div {...props}/>').join('')
  const audit = auditSpacingSource('fixture.tsx', `export const fixture = <>${elements}</>`)
  const report = formatSpacingReport([audit], reportOptions)
  expect(report).toContain('+2 more coverage-limited elements')
  expect(report).toContain('coverage: 0/22 intrinsic elements fully scanned; 0 partial; 22 unsupported')
})

test('the report prints only the normalization assumptions it actually uses', () => {
  const pixels = formatSpacingReport([
    auditSpacingSource('pixels.tsx', `export const fixture = <div style={{padding: '12px'}}/>`),
  ], reportOptions)
  expect(pixels).not.toContain('assumptions:')

  const rem = formatSpacingReport([
    auditSpacingSource('rem.tsx', `export const fixture = <div style={{padding: '0.5rem'}}/>`),
  ], reportOptions)
  expect(rem).toContain('assumptions: root font size = 16px.')
  expect(rem).not.toContain('Tailwind numeric spacing step')
})

test('the report rejects invalid normalization assumptions at its public boundary', () => {
  const audit = auditSpacingSource('fixture.tsx', `export const fixture = <div className="mt-2"/>`)
  expect(() => formatSpacingReport([audit], {
    pretty: false,
    normalization: {tailwindStepRem: 0, rootFontSizePx: 16},
  })).toThrow('positive finite Tailwind step')
  expect(() => formatSpacingReport([audit], {
    pretty: false,
    normalization: {tailwindStepRem: 0.25, rootFontSizePx: Number.NaN},
  })).toThrow('positive finite root font size')
})

// CLI coverage: the spacing command reads the file list from the resolved tsconfig
// without type-checking, so a project missing the jsx option still scans.
// fileURLToPath rather than URL.pathname: the pathname keeps percent-encoding, so a
// checkout under a directory with a space cannot resolve the CLI module.
const freerangeCli = fileURLToPath(new URL('../fr.ts', import.meta.url))

function runCli(cwd: string, ...arguments_: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, freerangeCli, ...arguments_],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function writeSpacingProject(directory: string, files: Record<string, string>): void {
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {strict: true, target: 'ESNext', module: 'ESNext', jsx: 'react-jsx'},
    include: ['**/*.ts', '**/*.tsx'],
  }))
  writeProjectFiles(directory, files)
}

function writeProjectFiles(directory: string, files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, source)
  }
}

const overlayComponent = [
  'export function Overlay(props: {y: number}) {',
  '  return <div className="mt-2" style={{top: props.y}}/>',
  '}',
].join('\n')

test('fr --spacing prints project findings and exits 0', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-spacing-'))
  try {
    writeSpacingProject(directory, {
      'overlay.tsx': overlayComponent,
      'layout.ts': 'export const GAP = 24\n',
    })
    const result = runCli(directory, '--spacing')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('overlay.tsx(2,10): warning [spacing-no-position]:')
    expect(result.stdout).toContain(`overlay.tsx(2,10): warning [spacing-mixed-margin]: class 'mt-2'`)
    expect(result.stdout).toContain('spacing ownership: 1 element with a visible inline margin or offset; 2 findings.')
    expect(result.stdout).toContain('coverage: 1/1 intrinsic element fully scanned; 0 partial; 0 unsupported across 2 files.')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('fr --spacing <file> narrows the output to that file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-spacing-'))
  try {
    writeSpacingProject(directory, {
      'overlay.tsx': overlayComponent,
      'clean.tsx': 'export function Clean(props: {y: number}) {\n  return <div className="absolute" style={{top: props.y}}/>\n}\n',
    })
    const narrowed = runCli(directory, '--spacing', 'clean.tsx')
    expect(narrowed.exitCode).toBe(0)
    expect(narrowed.stdout).toContain('No spacing ownership findings.')
    expect(narrowed.stdout).toContain('spacing ownership: 1 element with a visible inline margin or offset; 0 findings.')
    expect(narrowed.stdout).toContain('coverage: 1/1 intrinsic element fully scanned; 0 partial; 0 unsupported across 1 file.')

    const outside = runCli(directory, '--spacing', join('..', 'elsewhere.tsx'))
    expect(outside.exitCode).toBe(1)
    expect(outside.stderr).toContain('File not found')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('fr --spacing follows imports without type-checking and excludes non-project implementations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-spacing-'))
  try {
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: false,
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'preserve',
      },
      files: ['entry.ts'],
    }))
    writeProjectFiles(directory, {
      'entry.ts': `import './feature'\n`,
      'feature.ts': `import './overlay'\nimport './types.d.ts'\nimport './node_modules/dependency'\n`,
      'overlay.tsx': `const typeError: number = 'still scans'\n${overlayComponent}\n`,
      'types.d.ts': 'declare const importedType: number\n',
      'node_modules/dependency.tsx': 'export const dependency = <div className="mt-96"/>\n',
      'unused.tsx': 'export const unused = <div className="mt-80"/>\n',
    })

    const project = runCli(directory, '--spacing')
    expect(project.exitCode).toBe(0)
    expect(project.stdout).toContain('overlay.tsx(3,10): warning [spacing-no-position]:')
    expect(project.stdout).toContain('across 3 files')
    expect(project.stdout).not.toContain('mt-96')
    expect(project.stdout).not.toContain('mt-80')

    const targeted = runCli(directory, '--spacing', 'overlay.tsx')
    expect(targeted.exitCode).toBe(0)
    expect(targeted.stdout).toContain('overlay.tsx(3,10): warning [spacing-no-position]:')
    expect(targeted.stdout).toContain('across 1 file')

    for (const excluded of ['unused.tsx', 'types.d.ts', join('node_modules', 'dependency.tsx')]) {
      const result = runCli(directory, '--spacing', excluded)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('File is not part of the project')
    }
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('an auto margin is dialect-recognized and cannot stand a dead offset down', () => {
  const result = scanElements('<div className="mx-auto" style={{top: y}}/>')
  expect(result.details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
  expect(result.limitedCoverage).toEqual([])
})

test('a reverse space switch is dialect-recognized, not unmodeled', () => {
  const result = scanElements('<div className="space-y-4 space-y-reverse" style={{marginTop: y}}/>')
  expect(result.limitedCoverage).toEqual([])
})

test('a pseudo-element or variant position does not bypass the unmodeled-class stand-down', () => {
  const pseudo = scanElements('<div className="before:absolute custom-panel" style={{top: y}}/>')
  expect(pseudo.details).toEqual([])
  expect(pseudo.limitedCoverage).toEqual([{
    kind: 'partial',
    reasons: [{kind: 'unmodeledClass', className: 'custom-panel'}],
  }])

  const variant = scanElements('<div className="md:absolute custom-panel" style={{top: y}}/>')
  expect(variant.details).toEqual([])
  expect(variant.limitedCoverage).toEqual([{
    kind: 'partial',
    reasons: [{kind: 'unmodeledClass', className: 'custom-panel'}],
  }])
})

test('an explicit static class keeps the dead-offset finding past an unmodeled class', () => {
  const result = scanElements('<div className="static custom-panel" style={{top: y}}/>')
  expect(result.details).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: 'static'},
  ])
})

test('a custom multi-segment spacing name limits coverage instead of vanishing', () => {
  const result = scanElements('<div className="space-y-huge" style={{marginTop: y}}/>')
  expect(result.details).toEqual([])
  expect(result.limitedCoverage).toEqual([{
    kind: 'partial',
    reasons: [{kind: 'unmodeledClass', className: 'space-y-huge'}],
  }])
})
