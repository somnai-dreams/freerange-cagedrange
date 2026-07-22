import {describe, expect, test} from 'bun:test'
import {auditStateGeometrySource, classifyToken} from '../src/spacing/state-geometry.ts'

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

  test('classifies border tokens by whether the value is a length', () => {
    expect(classifyToken('border')).toMatchObject({kind: 'geometry', family: 'border-width', value: '1'})
    expect(classifyToken('border-t-2')).toMatchObject({kind: 'geometry', family: 'border-width-t', value: '2'})
    expect(classifyToken('border-transparent')).toMatchObject({kind: 'paint', family: 'border-color'})
    expect(classifyToken('border-light-100')).toMatchObject({kind: 'paint', family: 'border-color'})
    expect(classifyToken('hover:border')).toMatchObject({kind: 'geometry', variants: ['hover']})
    expect(classifyToken('rounded-full')).toMatchObject({kind: 'paint'})
  })
})
