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

  test('classifies border tokens by whether the value is a length', () => {
    expect(classifyToken('border')).toMatchObject({kind: 'geometry', family: 'border-width', value: '1'})
    expect(classifyToken('border-t-2')).toMatchObject({kind: 'geometry', family: 'border-width-t', value: '2'})
    expect(classifyToken('border-transparent')).toMatchObject({kind: 'paint', family: 'border-color'})
    expect(classifyToken('border-light-100')).toMatchObject({kind: 'paint', family: 'border-color'})
    expect(classifyToken('hover:border')).toMatchObject({kind: 'geometry', variants: ['hover']})
    expect(classifyToken('rounded-full')).toMatchObject({kind: 'paint'})
  })
})
