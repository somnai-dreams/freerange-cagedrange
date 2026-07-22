import {describe, expect, test} from 'bun:test'
import {auditStateGeometrySource, classifyToken, collectBreakpoints, formatBreakpointReport, type BreakpointUsage} from '../src/spacing/state-geometry.ts'
import * as ts from 'typescript'

const audit = (jsx: string) => auditStateGeometrySource('State.tsx', `
export function Component({active}: {active: boolean}) {
  return ${jsx}
}
`)

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

  test('transform-only differences are motion, not shift; mixing in a box property restores shift', () => {
    // The slide-reveal idiom: hover moves pixels on screen but reflows nothing.
    const revealed = audit(`<button className="translate-x-14 group-hover:translate-x-0" />`)
    expect(revealed.findings).toHaveLength(1)
    expect(revealed.findings[0]).toMatchObject({kind: 'variantGeometry', severity: 'motion'})

    // Negative spelling, no base at all: still an added transform, still paint-only.
    const nudgedIn = audit(`<button className="group-hover:-translate-x-14" />`)
    expect(nudgedIn.findings).toHaveLength(1)
    expect(nudgedIn.findings[0]).toMatchObject({kind: 'variantGeometry', severity: 'motion'})

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
