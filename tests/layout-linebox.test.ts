import {afterAll, describe, expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {resolveCssClasses} from '../src/layout/css.ts'
import {checkLineBoxContainment, type LineBoxContainmentClaim} from '../src/layout/linebox.ts'

// The three all-constant field bugs from the state-geometry miss report, as fixtures: a padded
// capsule over the prose strut, an exact-strut caret span under vertical-align middle, and a
// margin on an atomic inline. Buggy numbers fail with the write-up's arithmetic; the shipped
// fixes pass.

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, {recursive: true, force: true})
})

function project(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-linebox-'))
  directories.push(directory)
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, source)
  }
  return directory
}

function claim(overrides: Partial<LineBoxContainmentClaim>): LineBoxContainmentClaim {
  return {
    name: 'pills fit the editable line',
    context: ['prompt-editable'],
    inline: ['pill--prompt-bar'],
    assume: {contextFontSizePx: null},
    ...overrides,
  }
}

describe('line-box containment', () => {
  test('the pill capsule: 13px × inherited 1.625 + 4px padding overflows the 24.38px strut', () => {
    const index = resolveCssClasses(project({
      'src/index.css': `
        .prompt-editable { font-size: 15px; line-height: 1.625; }
        .pill--prompt-bar { display: inline-flex; padding: 2px 4px 2px 10px; font-size: 13px; }
      `,
    }))
    const buggy = checkLineBoxContainment(claim({}), index)
    expect(buggy.kind).toBe('fail')
    if (buggy.kind === 'fail') {
      expect(buggy.strutPx).toBeCloseTo(24.375, 2)
      expect(buggy.boxPx).toBeCloseTo(25.125, 2)
      expect(buggy.contributions.join(' ')).toContain('block padding 4px')
    }
  })

  test('the shipped fix passes: line-height 18px capsule fits, middle-aligned with slack', () => {
    const index = resolveCssClasses(project({
      'src/index.css': `
        .prompt-editable { font-size: 15px; line-height: 1.625; }
        .pill--prompt-bar {
          display: inline-flex; padding: 2px 4px 2px 10px; font-size: 13px;
          line-height: 18px; vertical-align: middle;
        }
      `,
    }))
    const fixed = checkLineBoxContainment(claim({}), index)
    expect(fixed).toMatchObject({kind: 'pass', verticalAlign: 'middle'})
    if (fixed.kind === 'pass') {
      expect(fixed.boxPx).toBeCloseTo(22, 2)
      expect(fixed.note).toContain('descent metrics are not modeled')
    }
  })

  test('an exact-strut box under vertical-align middle fails; under top it is an exact fit', () => {
    const css = (align: string) => project({
      'src/index.css': `
        .prompt-editable { font-size: 15px; line-height: 1.625; }
        .caret-landing { min-height: 1.625em; vertical-align: ${align}; }
      `,
    })
    const middle = checkLineBoxContainment(
      claim({name: 'caret span', inline: ['caret-landing']}),
      resolveCssClasses(css('middle')),
    )
    expect(middle.kind).toBe('fail')
    if (middle.kind === 'fail') {
      expect(middle.contributions.join(' ')).toContain('pushes descent past it')
    }

    const top = checkLineBoxContainment(
      claim({name: 'caret span', inline: ['caret-landing']}),
      resolveCssClasses(css('top')),
    )
    expect(top).toMatchObject({kind: 'pass', note: 'edge-aligned exact fit'})
  })

  test('a margin on an atomic inline participates in the line and can be the whole overflow', () => {
    const index = resolveCssClasses(project({
      'src/index.css': `
        .prompt-editable { font-size: 15px; line-height: 1.625; }
        .pill-wrapper { display: inline-flex; line-height: 23px; margin-bottom: 2px; }
      `,
    }))
    const check = checkLineBoxContainment(claim({name: 'wrapper margin', inline: ['pill-wrapper']}), index)
    expect(check.kind).toBe('fail')
    if (check.kind === 'fail') {
      expect(check.boxPx).toBeCloseTo(25, 2)
      expect(check.contributions.join(' ')).toContain('margin boxes participate')
    }
  })

  test('honest unknowns: tainted classes, missing declarations, missing font-size', () => {
    const index = resolveCssClasses(project({
      'src/a.css': `
        .prompt-editable { font-size: 15px; line-height: 1.625; }
        .pill--prompt-bar { padding: 2px; }
        .contested { padding: 2px; }
        @media (min-width: 640px) { .conditional { padding: 4px; } }
        .list .contested { padding: 8px; }
      `,
    }))
    expect(checkLineBoxContainment(claim({inline: ['contested']}), index)).toMatchObject({kind: 'unknown'})
    expect(checkLineBoxContainment(claim({inline: ['conditional']}), index)).toMatchObject({kind: 'unknown'})
    expect(checkLineBoxContainment(claim({inline: ['never-declared']}), index)).toMatchObject({kind: 'unknown'})

    const noFont = resolveCssClasses(project({
      'src/a.css': `
        .prompt-editable { line-height: 1.625; }
        .pill--prompt-bar { padding: 2px; }
      `,
    }))
    const unknownFont = checkLineBoxContainment(claim({}), noFont)
    expect(unknownFont.kind).toBe('unknown')
    if (unknownFont.kind === 'unknown') expect(unknownFont.reason).toContain('assume.contextFontSizePx')
    // The declared assumption unblocks it — and is echoed by the arithmetic (15 × 1.625 + 4).
    const assumed = checkLineBoxContainment(claim({assume: {contextFontSizePx: 15}}), noFont)
    expect(assumed.kind).toBe('fail')
  })

  test('cross-file same-property declarations taint instead of guessing load order', () => {
    const index = resolveCssClasses(project({
      'src/a.css': '.pill--prompt-bar { padding: 2px; }',
      'src/b.css': '.pill--prompt-bar { padding: 6px; }',
      'src/context.css': '.prompt-editable { font-size: 15px; line-height: 1.625; }',
    }))
    const check = checkLineBoxContainment(claim({}), index)
    expect(check.kind).toBe('unknown')
    if (check.kind === 'unknown') expect(check.reason).toContain('load order is unknown')
  })

  test('Tailwind-style dotted names are expressible: escaped selectors resolve, generated-CSS classes are honest unknowns', () => {
    // A hand-written escaped rule resolves and the fractional margin participates in the line.
    const index = resolveCssClasses(project({
      'src/a.css': `
        .prompt-editable { font-size: 15px; line-height: 1.625; }
        .chip { display: inline-flex; line-height: 23px; }
        .mb-0\\.5 { margin-bottom: 2px; }
      `,
    }))
    const check = checkLineBoxContainment(claim({name: 'chip margin', inline: ['chip', 'mb-0.5']}), index)
    expect(check.kind).toBe('fail')
    if (check.kind === 'fail') expect(check.boxPx).toBeCloseTo(25, 2)

    // The same name with no stylesheet backing evaluates from the Tailwind default scale: the
    // fractional margin participates in the line and can be the whole overflow — the field
    // report's third bug, claimable with zero product change.
    const bare = resolveCssClasses(project({
      'src/a.css': `
        .prompt-editable { font-size: 15px; line-height: 1.625; }
        .chip { display: inline-flex; line-height: 23px; }
      `,
    }))
    const bridged = checkLineBoxContainment(claim({name: 'chip margin', inline: ['chip', 'mb-0.5']}), bare)
    expect(bridged.kind).toBe('fail')
    if (bridged.kind === 'fail') {
      expect(bridged.boxPx).toBeCloseTo(25, 2)
      expect(bridged.contributions.join(' ')).toContain('margin boxes participate')
    }

    // A name that is neither stylesheet-declared nor a recognized utility stays unknown.
    const unresolved = checkLineBoxContainment(claim({name: 'chip margin', inline: ['chip', 'chip-wrapper']}), bare)
    expect(unresolved.kind).toBe('unknown')
    if (unresolved.kind === 'unknown') expect(unresolved.reason).toContain("'chip-wrapper' is not declared")
  })

  test('a pure-Tailwind inline box needs no stylesheet at all', () => {
    // text-sm brings the paired default line height (14px/20px); py-1 adds 8px of block
    // padding; the capsule presents 28px against a 24.38px strut.
    const index = resolveCssClasses(project({
      'src/a.css': '.prompt-editable { font-size: 15px; line-height: 1.625; }',
    }))
    const overflowing = checkLineBoxContainment(
      claim({name: 'utility capsule', inline: ['inline-flex', 'text-sm', 'py-1']}),
      index,
    )
    expect(overflowing.kind).toBe('fail')
    if (overflowing.kind === 'fail') {
      expect(overflowing.boxPx).toBeCloseTo(28, 2)
      expect(overflowing.strutPx).toBeCloseTo(24.375, 2)
    }

    // leading-none shrinks the content line: 14px × 1 + 8px = 22px fits.
    const fitting = checkLineBoxContainment(
      claim({name: 'utility capsule', inline: ['inline-flex', 'text-sm', 'leading-none', 'py-1', 'align-middle']}),
      index,
    )
    expect(fitting).toMatchObject({kind: 'pass', verticalAlign: 'middle'})
    if (fitting.kind === 'pass') expect(fitting.boxPx).toBeCloseTo(22, 2)
  })

  test('block-level display is not a line-box question', () => {
    const index = resolveCssClasses(project({
      'src/a.css': `
        .prompt-editable { font-size: 15px; line-height: 1.625; }
        .block-child { display: block; padding: 20px; }
      `,
    }))
    expect(checkLineBoxContainment(claim({inline: ['block-child']}), index)).toMatchObject({kind: 'unknown'})
  })
})
