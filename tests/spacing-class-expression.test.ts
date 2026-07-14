import {expect, test} from 'bun:test'
import * as ts from 'typescript'
import {classAttributeSummary, hasPositionOnEveryOutcome} from '../src/spacing/class-expression.ts'
import type {ClassSummary} from '../src/spacing/model.ts'

function summarize(expression: string): ClassSummary {
  const sourceFile = ts.createSourceFile(
    'fixture.tsx',
    `const element = <div className={${expression}}/>`,
    ts.ScriptTarget.ESNext,
    false,
    ts.ScriptKind.TSX,
  )
  const classAttributes: ts.JsxAttribute[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'className') {
      classAttributes.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const classAttribute = classAttributes[0]
  if (classAttribute === undefined) throw new Error('Fixture did not contain a className attribute')
  return classAttributeSummary(classAttribute)
}

test('literal class values occupy the finite truthiness and position states', () => {
  expect(summarize('null').outcomes).toEqual([{kind: 'nullish'}])
  expect(summarize("''").outcomes).toEqual([{kind: 'falsy'}])
  expect(summarize("'text-sm'").outcomes).toEqual([{kind: 'truthy', position: 'none'}])
  expect(summarize("'static'").outcomes).toEqual([{kind: 'truthy', position: 'static'}])
  expect(summarize("'absolute'").outcomes).toEqual([{kind: 'truthy', position: 'positioned'}])
  expect(summarize("'absolute static'").outcomes).toEqual([
    {kind: 'truthy', position: 'positionedThenStatic'},
  ])
})

test('short-circuit operators preserve their different runtime result sets', () => {
  expect(hasPositionOnEveryOutcome(summarize("open && 'absolute'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("(open && 'absolute') || 'relative'"))).toBe(true)
  expect(hasPositionOnEveryOutcome(summarize("(open && 'absolute') ?? 'relative'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("(open ? null : 'absolute') ?? 'relative'"))).toBe(true)
})

test('combiner objects and arrays stay within the six canonical outcomes', () => {
  const summary = summarize("cn([{absolute: open}], {relative: sticky}, ['mt-2', extra])")
  expect(summary.outcomes.length).toBeLessThanOrEqual(6)
  expect(summary.possibleClasses.map(classFact => classFact.token)).toEqual([
    'absolute', 'relative', 'mt-2',
  ])
  expect(summary.coverage).toBe('partial')
})

test('normal class joining and Tailwind Merge interpret a later static utility differently', () => {
  expect(hasPositionOnEveryOutcome(summarize("cn('absolute', extra)"))).toBe(true)
  expect(hasPositionOnEveryOutcome(summarize("twMerge('absolute', extra)"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("twMerge(extra, 'absolute')"))).toBe(true)
  expect(hasPositionOnEveryOutcome(summarize("twMerge(twMerge('absolute', extra), 'relative')"))).toBe(true)
})

test('delimited dynamic classes retain visible facts while fused tokens do not', () => {
  const delimited = summarize('`absolute ${extra}`')
  expect(delimited.possibleClasses.map(classFact => classFact.token)).toEqual(['absolute'])
  expect(hasPositionOnEveryOutcome(delimited)).toBe(true)
  expect(delimited.coverage).toBe('partial')

  const fused = summarize('`absolute-${size}`')
  expect(fused.possibleClasses).toEqual([])
  expect(hasPositionOnEveryOutcome(fused)).toBe(false)
  expect(fused.coverage).toBe('partial')
})

test('templates and concatenation model JavaScript stringification before fallback operators', () => {
  expect(hasPositionOnEveryOutcome(summarize("`${null}` || 'absolute'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("`${false}` || 'absolute'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("`${0}` || 'absolute'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("(null + '') || 'absolute'"))).toBe(false)
})

test('computed combiner object keys use JavaScript property-key coercion', () => {
  expect(hasPositionOnEveryOutcome(summarize("cn({[null]: true}) || 'absolute'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("cn({[false]: true}) || 'absolute'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("cn({1: true}) || 'absolute'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("cn({['absolute']: true})"))).toBe(true)
})

test('obviously truthy syntax selects class branches without inventing false outcomes', () => {
  expect(hasPositionOnEveryOutcome(summarize("({}) ? 'absolute' : ''"))).toBe(true)
  expect(hasPositionOnEveryOutcome(summarize("[] && 'absolute'"))).toBe(true)
  expect(hasPositionOnEveryOutcome(summarize("cn({absolute: []})"))).toBe(true)
  expect(hasPositionOnEveryOutcome(summarize("cn({absolute: !false})"))).toBe(true)
  expect(hasPositionOnEveryOutcome(summarize("cn(1) || 'absolute'"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("cn(0) || 'absolute'"))).toBe(true)
})

test('repeated conditions remain conservative without symbolic correlation', () => {
  expect(hasPositionOnEveryOutcome(summarize("cn(open && 'absolute', !open && 'relative')"))).toBe(false)
  expect(hasPositionOnEveryOutcome(summarize("cn(open && 'absolute', 'relative')"))).toBe(true)
})
