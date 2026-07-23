import {describe, expect, test} from 'bun:test'
import {auditStateGeometrySource, breakpointReportData, classifyToken, collectBreakpoints, formatBreakpointReport, stateGeometryReportData, type BreakpointUsage} from '../src/spacing/state-geometry.ts'
import * as ts from 'typescript'

const audit = (jsx: string) => auditStateGeometrySource('State.tsx', `
export function Component({active}: {active: boolean}) {
  return ${jsx}
}
`)

describe('structured report data', () => {
  test('relativizes paths, orders by tier, and tallies severities', () => {
    const audit = auditStateGeometrySource('/repo/src/State.tsx', `
export function Panel() {
  const [open, setOpen] = useState(false)
  return <div>
    <span className={open ? 'border p-2' : 'p-2'} />
    <span className="translate-x-14 group-hover:translate-x-0" />
  </div>
}
`)
    const data = stateGeometryReportData([audit], [], '/repo')
    expect(data.findings.map(finding => finding.file)).toEqual(['src/State.tsx', 'src/State.tsx'])
    expect(data.findings[0]!.severity).toBe('shift')
    expect(data.findings[1]!.severity).toBe('motion')
    expect(data.counts).toEqual({shift: 1, motion: 1, unclear: 0, config: 0})
    expect(data.coverage).toBe(0)
  })

  test('breakpoint data mirrors the text report', () => {
    const usage = new Map<number, BreakpointUsage>()
    usage.set(768, {thresholdPx: 768, variants: new Map([['md', 3]])})
    usage.set(640, {thresholdPx: 640, variants: new Map([['sm', 5], ['max-sm', 1]])})
    expect(breakpointReportData(usage)).toEqual({
      breakpoints: [
        {thresholdPx: 640, variants: [{variant: 'sm', count: 5}, {variant: 'max-sm', count: 1}]},
        {thresholdPx: 768, variants: [{variant: 'md', count: 3}]},
      ],
      seams: [639, 640, 767, 768],
    })
  })
})

describe('style-attribute geometry', () => {
  test('the field-report shape: a const ternary with a runtime branch feeding style aspect-ratio', () => {
    // Verbatim idiom from the miss report: the discriminating ternary lives in a local const,
    // one branch is a literal, the other a runtime prop. The value is unknowable; the claim —
    // branches disagree unless proven equal — is not.
    const audit = auditStateGeometrySource('State.tsx', `
export function SrefThumb({previewUrl, previewLoading, previewAspectRatio}) {
  const containerAspectRatio =
    (previewUrl || previewLoading) && previewAspectRatio ? previewAspectRatio : '16/9'
  return <div style={{ aspectRatio: containerAspectRatio }} />
}
`)
    expect(audit.findings).toHaveLength(1)
    expect(audit.findings[0]).toMatchObject({kind: 'styleGeometry', magnitudePx: null})
    expect(audit.findings[0]!.detail).toContain('aspect-ratio')
    expect(audit.findings[0]!.detail).toContain("'16/9'")
    expect(audit.findings[0]!.evidence).toContain('differs unless proven equal')
  })

  test('literal-vs-literal quantifies; identical dynamic text is proven equal; hooks make it shift', () => {
    const quantified = auditStateGeometrySource('State.tsx', `
export function Panel() {
  const [expanded, setExpanded] = useState(false)
  return <div style={{ height: expanded ? 240 : '120px' }} />
}
`)
    expect(quantified.findings).toHaveLength(1)
    expect(quantified.findings[0]).toMatchObject({kind: 'styleGeometry', severity: 'shift', magnitudePx: 120})

    const provenEqual = auditStateGeometrySource('State.tsx', `
export function Panel({size, open}) {
  return <div style={open ? {width: size, display: 'flex'} : {width: size, display: 'flex'}} />
}
`)
    expect(provenEqual.findings).toEqual([])
    expect(provenEqual.coverage).toEqual([])
  })

  test('unextractable style attributes and dynamic disagreements are coverage, never silent', () => {
    const opaque = auditStateGeometrySource('State.tsx', `
export function Panel({styles}) {
  return <div style={styles.container} />
}
`)
    expect(opaque.findings).toEqual([])
    expect(opaque.coverage).toEqual([{file: 'State.tsx', line: 3, reason: 'dynamicStylePart'}])

    // Two different runtime expressions: could be equal at runtime, so no finding — coverage.
    const disagreeing = auditStateGeometrySource('State.tsx', `
export function Panel({a, b, open}) {
  return <div style={{ width: open ? a : b }} />
}
`)
    expect(disagreeing.findings).toEqual([])
    expect(disagreeing.coverage).toEqual([{file: 'State.tsx', line: 3, reason: 'dynamicStylePart'}])

    // Unmodeled properties never enter the claim: a conditional color is not geometry.
    const painted = auditStateGeometrySource('State.tsx', `
export function Panel({open}) {
  return <div style={{ color: open ? 'red' : 'blue' }} />
}
`)
    expect(painted.findings).toEqual([])
    expect(painted.coverage).toEqual([])
  })

  test('shorthand style properties resolve through the same scope', () => {
    const shorthand = auditStateGeometrySource('State.tsx', `
export function Card({previewUrl, previewLoading, previewAspectRatio}) {
  const aspectRatio = (previewUrl || previewLoading) && previewAspectRatio ? previewAspectRatio : '2/1'
  return <div style={{ aspectRatio }} />
}
`)
    expect(shorthand.findings).toHaveLength(1)
    expect(shorthand.findings[0]).toMatchObject({kind: 'styleGeometry'})
    expect(shorthand.findings[0]!.detail).toContain("'2/1'")
  })

  test('aspect utility tokens are geometry: a state-variant aspect change is a finding', () => {
    const snapped = audit(`<div className="aspect-video hover:aspect-square" />`)
    expect(snapped.findings).toHaveLength(1)
    expect(snapped.findings[0]!.detail).toContain('aspect')
  })
})

describe('state-variant geometry scan', () => {
  test('a conditional border width is a finding; a reserved border varying only in color is clean', () => {
    const shifting = audit(`<button className={active ? 'border border-light-300' : ''} />`)
    expect(shifting.findings).toHaveLength(1)
    expect(shifting.findings[0]).toMatchObject({kind: 'branchGeometry'})
    expect(shifting.findings[0]!.detail).toContain('left inset -1px')
    expect(shifting.findings[0]!.magnitudePx).toBe(1)

    const reserved = audit("<button className={`border ${active ? 'border-light-300' : 'border-transparent'}`} />")
    expect(reserved.findings).toEqual([])
    expect(reserved.coverage).toEqual([])

    // Different spellings, identical geometry: 1px border + 16px padding vs 17px padding.
    const compensated = audit(`<button className={active ? 'border p-4' : 'p-[17px]'} />`)
    expect(compensated.findings).toEqual([])
  })

  test('a state-variant token adding or changing geometry is a finding; paint variants are clean', () => {
    const unreserved = audit(`<button className="rounded hover:border" />`)
    expect(unreserved.findings).toHaveLength(1)
    expect(unreserved.findings[0]).toMatchObject({kind: 'variantGeometry'})
    expect(unreserved.findings[0]!.detail).toContain('no base reservation')

    const widened = audit(`<button className="border hover:border-2" />`)
    expect(widened.findings).toHaveLength(1)
    expect(widened.findings[0]!.detail).toContain("changes border-width from the base '1'")

    const painted = audit(`<button className="border border-transparent hover:border-light-300 hover:bg-light-50" />`)
    expect(painted.findings).toEqual([])
  })

  test('a prop fed from a hook at any call site makes its branches live', () => {
    // The field-report shape: SrefThumb's discriminants are props, and the call site feeds them
    // from hook state — the branches are live for that instance, so the severity is shift.
    const source = (feeder: string) => auditStateGeometrySource('State.tsx', `
export function Thumb({loading}) {
  return <div style={{ aspectRatio: loading ? '1/1' : '16/9' }} />
}
export function Grid() {
  ${feeder}
  return <Thumb loading={busy} />
}
`)
    const hookFed = source('const [busy, setBusy] = useState(false)')
    expect(hookFed.findings).toHaveLength(1)
    expect(hookFed.findings[0]).toMatchObject({kind: 'styleGeometry', severity: 'shift'})
    expect(hookFed.findings[0]!.evidence).toContain("a call site feeds 'loading' from a hook")

    // The same component with the prop fixed by literals everywhere stays configuration.
    const literal = auditStateGeometrySource('State.tsx', `
export function Thumb({loading}) {
  return <div style={{ aspectRatio: loading ? '1/1' : '16/9' }} />
}
export function Grid() {
  return <Thumb loading={false} />
}
`)
    expect(literal.findings).toHaveLength(1)
    expect(literal.findings[0]).toMatchObject({severity: 'config'})
  })

  test('transform-only differences are motion, not shift; mixing in a box property restores shift', () => {
    // The slide-reveal idiom: hover moves pixels on screen but reflows nothing.
    const revealed = audit(`<button className="translate-x-14 group-hover:translate-x-0" />`)
    expect(revealed.findings).toHaveLength(1)
    expect(revealed.findings[0]).toMatchObject({kind: 'variantGeometry', severity: 'motion'})

    // Negative spelling, no base at all: still an added transform, still paint-only.
    const nudgedIn = audit(`<button className="group-hover:-translate-x-14" />`)
    expect(nudgedIn.findings).toHaveLength(1)
    expect(nudgedIn.findings[0]).toMatchObject({kind: 'variantGeometry', severity: 'motion'})

    // Opposite sign spellings are the same family: the full crossing distance is the magnitude.
    const crossed = audit(`<button className="-translate-x-14 group-hover:translate-x-0" />`)
    expect(crossed.findings).toHaveLength(1)
    expect(crossed.findings[0]).toMatchObject({kind: 'variantGeometry', severity: 'motion', magnitudePx: 56})
    expect(crossed.findings[0]!.detail).toContain("from the base '-14'")

    const swung = audit(`<button className="translate-x-14 group-hover:-translate-x-14" />`)
    expect(swung.findings).toHaveLength(1)
    expect(swung.findings[0]!.magnitudePx).toBe(112)

    // Branch spellings normalize to one signed categorical entry, not an add/remove pair.
    const flipped = auditStateGeometrySource('State.tsx', `
export function Panel() {
  const [open, setOpen] = useState(false)
  return <div className={open ? 'translate-x-4' : '-translate-x-4'} />
}
`)
    expect(flipped.findings).toHaveLength(1)
    expect(flipped.findings[0]!.detail).toContain("translate-x '16px' vs '-16px'")

    // Hook-rooted, still transform-only: live motion, but neighbors never move.
    const nudged = auditStateGeometrySource('State.tsx', `
export function Panel() {
  const [open, setOpen] = useState(false)
  return <div className={open ? 'translate-x-4' : 'translate-x-0'} />
}
`)
    expect(nudged.findings).toHaveLength(1)
    expect(nudged.findings[0]).toMatchObject({kind: 'branchGeometry', severity: 'motion'})

    // A padding change rides along: the difference reflows, so the transform does not soften it.
    const displaced = auditStateGeometrySource('State.tsx', `
export function Panel() {
  const [open, setOpen] = useState(false)
  return <div className={open ? 'translate-x-4 pl-2' : 'translate-x-0'} />
}
`)
    expect(displaced.findings.length).toBeGreaterThan(0)
    for (const finding of displaced.findings) expect(finding.severity).toBe('shift')
  })

  test('always-out-of-flow elements are overlay-bounded motion; toggling flow mode is not', () => {
    // The hover-reveal action rail: hidden→flex on an element that is absolute in every state.
    const revealed = audit(`<div className="absolute bottom-4 hidden group-hover:flex" />`)
    expect(revealed.findings).toHaveLength(1)
    expect(revealed.findings[0]).toMatchObject({kind: 'variantGeometry', severity: 'motion'})
    expect(revealed.findings[0]!.evidence).toContain('out of flow in every branch')

    // A hook moving an absolute menu between two anchors: overlay glide, siblings never move.
    const glided = auditStateGeometrySource('State.tsx', `
export function Menu() {
  const [pinned, setPinned] = useState(false)
  return <div className={pinned ? 'absolute pl-2' : 'absolute pl-8'} />
}
`)
    expect(glided.findings).toHaveLength(1)
    expect(glided.findings[0]).toMatchObject({kind: 'branchGeometry', severity: 'motion'})

    // State toggling position itself pulls the element out of flow: siblings collapse in — the
    // opposite of an overlay, and the guard must keep it top-tier.
    const modeToggled = auditStateGeometrySource('State.tsx', `
export function Panel() {
  const [floating, setFloating] = useState(false)
  return <div className={floating ? 'absolute pl-2' : 'pl-2'} />
}
`)
    expect(modeToggled.findings.length).toBeGreaterThan(0)
    for (const finding of modeToggled.findings) expect(finding.severity).toBe('shift')

    // Containment rung: an in-flow child whose ancestor is absolute in every branch reflows only
    // the overlay's interior.
    const contained = audit(`<div className="absolute inset-x-0 bottom-0"><span className="hidden group-hover:block" /></div>`)
    const child = contained.findings.find(finding => finding.detail.includes('group-hover:block'))
    expect(child).toMatchObject({severity: 'motion'})
    expect(child!.evidence).toContain('inside an out-of-flow ancestor')
  })

  test('transition tokens classify how the difference plays out in time', () => {
    // Box property under transition-all: the shift is animated reflow, every frame of it.
    const animated = auditStateGeometrySource('State.tsx', `
export function Panel() {
  const [open, setOpen] = useState(false)
  return <div className={open ? 'transition-all pl-8' : 'transition-all pl-2'} />
}
`)
    expect(animated.findings[0]!.severity).toBe('shift')
    expect(animated.findings[0]!.evidence).toContain('layout reflows every frame')

    // Split coverage: width tweens under the default transition scope, padding snaps beside it.
    const partial = auditStateGeometrySource('State.tsx', `
export function Panel() {
  const [open, setOpen] = useState(false)
  return <div className={open ? 'transition translate-x-4 pl-8' : 'transition translate-x-0 pl-2'} />
}
`)
    expect(partial.findings[0]!.evidence).toContain('partial tween')

    // Display cannot tween: a declared transition still pops the flip.
    const popped = audit(`<div className="transition-all hidden group-hover:flex" />`)
    expect(popped.findings[0]!.evidence).toContain('so the flip pops')

    // No transition declared: no timing clause at all.
    const instant = audit(`<button className="rounded hover:border" />`)
    expect(instant.findings[0]!.evidence).not.toContain('transition:')
  })

  test('conditional spacing, font size, and display changes are findings; color and rounding are not', () => {
    expect(audit(`<div className={active ? 'pl-2' : 'pl-4'} />`).findings).toHaveLength(1)
    expect(audit(`<div className={active ? 'text-sm' : 'text-lg'} />`).findings).toHaveLength(1)
    expect(audit(`<div className={active ? 'hidden' : 'block'} />`).findings).toHaveLength(1)
    expect(audit(`<div className={active ? 'text-white rounded-lg' : 'text-black rounded-sm'} />`).findings)
      .toEqual([])
  })

  test('clsx object conditions participate and dynamic parts become coverage, not guesses', () => {
    const object = audit(`<div className={cn('flex', {'mt-2': active})} />`)
    expect(object.findings).toHaveLength(1)

    const dynamic = audit(`<div className={themeClasses} />`)
    expect(dynamic.findings).toEqual([])
    expect(dynamic.coverage).toEqual([{file: 'State.tsx', line: 3, reason: 'dynamicClassPart'}])
  })

  test('same-family tokens override by specificity and importance instead of summing', () => {
    // `border border-b-0`: the single-edge utility wins its edge, so only the bottom differs.
    const reset = audit(`<div className={active ? 'border border-b-0' : 'border'} />`)
    expect(reset.findings).toHaveLength(1)
    expect(reset.findings[0]!.detail).toContain('bottom inset +1px')
    expect(reset.findings[0]!.detail).not.toContain('left inset')

    // The important marker beats a plain base token regardless of order.
    const important = audit(`<div className={active ? 'border-l-0! border-l' : 'border-l'} />`)
    expect(important.findings).toHaveLength(1)
    expect(important.findings[0]!.detail).toContain('left inset +1px')

    // Equal targeting with distinct values depends on stylesheet order: honestly unresolved,
    // and identical unresolved conflicts on both sides stay clean.
    const conflict = audit(`<div className={active ? 'pl-2 pl-4' : 'pl-6'} />`)
    expect(conflict.findings).toHaveLength(1)
    expect(conflict.findings[0]!.detail).toBe("state shifts layout: padding(left) 'unresolved conflict' vs '24px'")
    const sharedConflict = audit("<div className={`pl-2 pl-4 ${active ? 'text-white' : 'text-black'}`} />")
    expect(sharedConflict.findings).toEqual([])
  })

  test('sibling instantiations of a component compare through the className splice', () => {
    // The mj sidebar bug shape: the shell always declares border-l, one call site strips it with
    // an important override, the other passes only dynamic classes. The two instances disagree by
    // exactly the border width.
    const source = `
export function Shell({className}: {className: string}) {
  return <div className={\`absolute border-l border-light-100 \${className}\`} />
}
export function Page({transition}: {transition: string}) {
  return <>
    <Shell className={\`overflow-hidden! border-l-0! \${transition}\`} />
    <Shell className={transition} />
  </>
}
`
    const result = auditStateGeometrySource('Shell.tsx', source)
    const instance = result.findings.filter(finding => finding.kind === 'instanceGeometry')
    expect(instance).toHaveLength(1)
    expect(instance[0]!.detail).toContain('<Shell> instances disagree')
    expect(instance[0]!.detail).toContain('left inset +1px')
    expect(instance[0]!.magnitudePx).toBe(1)
    // The call site overrides border-l, geometry the shell itself declares.
    expect(instance[0]!.severity).toBe('shift')

    // Call sites differing only in paint make no instance claim.
    const painted = auditStateGeometrySource('Shell.tsx', `
export function Shell({className}: {className: string}) {
  return <div className={\`border \${className}\`} />
}
export function Page() {
  return <>
    <Shell className="border-light-100" />
    <Shell className="border-dark-750" />
  </>
}
`)
    expect(painted.findings.filter(finding => finding.kind === 'instanceGeometry')).toEqual([])
  })

  test('severity follows whether the discriminant can change while mounted', () => {
    // Hook-rooted condition: the element transitions live — a real shift.
    const stateful = auditStateGeometrySource('S.tsx', `
export function Panel() {
  const [open, setOpen] = useState(false)
  return <div className={open ? 'border p-2' : 'p-2'} />
}
`)
    expect(stateful.findings[0]).toMatchObject({severity: 'shift'})
    expect(stateful.findings[0]!.evidence).toContain("'open' comes from a hook")

    // Orientation-style prop fixed by every call site: configurations, not motion.
    const configured = auditStateGeometrySource('S.tsx', `
export function Separator({orientation}: {orientation: 'horizontal' | 'vertical'}) {
  return <div className={orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px'} />
}
export function Page() {
  return <>
    <Separator orientation="horizontal" />
    <Separator orientation="vertical" />
  </>
}
`)
    expect(configured.findings[0]).toMatchObject({severity: 'config'})
    expect(configured.findings[0]!.evidence).toContain("every call site fixes 'orientation' with a literal")

    // A discriminant the bounded analysis cannot resolve stays honestly unclear.
    const unresolved = auditStateGeometrySource('S.tsx', `
export function Row({item}: {item: {expanded: boolean}}) {
  return <div className={item.expanded ? 'p-4' : 'p-2'} />
}
`)
    expect(unresolved.findings[0]).toMatchObject({severity: 'unclear'})
  })

  test('caller-owned sizing on a paint-only primitive is config, not a shift', () => {
    const result = auditStateGeometrySource('Skeleton.tsx', `
export function Skeleton({className}: {className: string}) {
  return <div className={\`animate-pulse rounded-md bg-muted \${className}\`} />
}
export function Cards() {
  return <>
    <Skeleton className="h-5 w-2/5" />
    <Skeleton className="h-4 w-4/5" />
  </>
}
`)
    const instance = result.findings.filter(finding => finding.kind === 'instanceGeometry')
    expect(instance).toHaveLength(1)
    expect(instance[0]!.severity).toBe('config')
    expect(instance[0]!.evidence).toContain('caller-owned sizing')
  })

  test('classifies border tokens by whether the value is a length', () => {
    expect(classifyToken('border')).toMatchObject({kind: 'geometry', family: 'border-width', value: '1'})
    expect(classifyToken('border-t-2')).toMatchObject({kind: 'geometry', family: 'border-width-t', value: '2'})
    expect(classifyToken('border-transparent')).toMatchObject({kind: 'paint', family: 'border-color'})
    expect(classifyToken('border-light-100')).toMatchObject({kind: 'paint', family: 'border-color'})
    expect(classifyToken('hover:border')).toMatchObject({kind: 'geometry', variants: ['hover']})
    expect(classifyToken('rounded-full')).toMatchObject({kind: 'paint'})
  })
})

describe('breakpoint derivation', () => {
  test('derives thresholds from responsive variants and reports boundary seams', () => {
    const sourceFile = ts.createSourceFile('B.tsx', `
export function Page() {
  return <div className="p-2 md:p-4 max-lg:hidden min-[900px]:flex sm:max-md:block" />
}
`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const usage = new Map<number, BreakpointUsage>()
    collectBreakpoints(sourceFile, usage)
    expect([...usage.keys()].sort((a, b) => a - b)).toEqual([640, 768, 900, 1024])
    const report = formatBreakpointReport(usage)
    expect(report).toContain('768px — ')
    expect(report).toContain('test seams: 639, 640, 767, 768, 899, 900, 1023, 1024')
  })
})

describe('per-interval responsive evaluation', () => {
  test('a responsive variant scopes the finding to its interval instead of conflicting', () => {
    const scoped = audit(`<div className={active ? 'p-2' : 'p-2 md:p-4'} />`)
    expect(scoped.findings).toHaveLength(1)
    expect(scoped.findings[0]!.detail).toBe(
      'state shifts layout from 768px: left inset +8px, right inset +8px, top inset +8px, bottom inset +8px',
    )

    // Below the threshold the branches agree; identical responsive tokens are not a conflict.
    const identical = audit(`<div className={active ? 'p-2 md:p-4' : 'p-2 md:p-4'} />`)
    expect(identical.findings).toEqual([])
  })

  test('max variants scope below the threshold and instance findings carry intervals', () => {
    const below = audit(`<div className={active ? 'max-md:pl-4 pl-2' : 'pl-2'} />`)
    expect(below.findings).toHaveLength(1)
    expect(below.findings[0]!.detail).toContain('below 768px')

    const instances = auditStateGeometrySource('Shell.tsx', `
export function Shell({className}: {className: string}) {
  return <div className={\`border-l \${className}\`} />
}
export function Page() {
  return <>
    <Shell className="p-1" />
    <Shell className="p-1 md:border-l-0!" />
  </>
}
`)
    const instance = instances.findings.filter(finding => finding.kind === 'instanceGeometry')
    expect(instance).toHaveLength(1)
    expect(instance[0]!.detail).toContain('instances disagree from 768px')
    expect(instance[0]!.severity).toBe('shift')
  })

  test('dark-mode variants compare as their own dimension instead of merging with the base', () => {
    const dark = audit(`<div className={active ? 'border dark:border-2' : 'border'} />`)
    expect(dark.findings).toHaveLength(1)
    expect(dark.findings[0]!.detail).toContain("dark:border-width '2px' vs 'none'")
    expect(dark.findings[0]!.detail).not.toContain('inset')
  })
})
