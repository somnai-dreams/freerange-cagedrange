import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {formatSpacingReport, scanSpacingSource, type SpacingFindingDetail, type SpacingValueSite} from '../src/index.ts'

// Each scan wraps the element in a component so the fixture is a complete TSX file; the
// scan itself never needs the surrounding code to type-check.
function scanElements(elements: string): {inlineSpacedElements: number; details: SpacingFindingDetail[]} {
  const source = `export function Fixture(y: number, x: number) {\n  return <main>${elements}</main>\n}\n`
  const scan = scanSpacingSource('fixture.tsx', source)
  return {
    inlineSpacedElements: scan.inlineSpacedElements,
    details: scan.findings.map(finding => finding.detail),
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
  expect(scanSpacingSource('fixture.tsx', source).findings.map(finding => finding.detail)).toEqual([
    {kind: 'offsetWithoutPosition', styleProperty: 'top', positionClass: null},
  ])
})

test('a props spread makes the element unscannable and blocks the other checks', () => {
  expect(scanElements('<div {...({} as object)} className="mt-4" style={{top: y}}/>').details).toEqual([
    {kind: 'unscannable', cause: 'spreadAttributes'},
  ])
})

test('a spread inside the style object makes the element unscannable', () => {
  expect(scanElements('<div style={{...({} as object), top: y}}/>').details).toEqual([
    {kind: 'unscannable', cause: 'opaqueStyleMember'},
  ])
})

test('a fully computed className makes the element unscannable', () => {
  expect(scanElements('<div className={dynamicClasses} style={{top: y}}/>').details).toEqual([
    {kind: 'unscannable', cause: 'computedClassName'},
  ])
})

// The extraction reads cn(...)-style calls, templates, ternaries, and && arms, so the
// statically visible classes are checked even when the full list is not knowable. The
// partial note prints after the findings; proving the element unpositioned is the one
// check that stands down, since an unseen class may add `absolute`.
test('classes visible inside cn(...) are checked; the unseen rest gets a note', () => {
  expect(scanElements(`<div className={cn('absolute mt-2', extra)} style={{top: y}}/>`).details).toEqual([
    {kind: 'marginClassOnOwnedAxis', axis: 'vertical', styleProperty: 'top', className: 'mt-2'},
    {kind: 'unscannable', cause: 'partialClassName'},
  ])
  expect(scanElements(`<div className={CN('inset-0', props.className)} style={{top: y}}/>`).details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'top', styleProperty: 'top', className: 'inset-0'},
    {kind: 'unscannable', cause: 'partialClassName'},
  ])
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
  expect(scanElements('<div className={`absolute ${extra}`} style={{top: y}}/>').details).toEqual([
    {kind: 'unscannable', cause: 'partialClassName'},
  ])
  // `mt-${size}` builds a class the scan cannot name: no mt- token is invented, and
  // with nothing visible the element falls back to the fully computed note.
  expect(scanElements('<div className={`mt-${size}`} style={{marginTop: y}}/>').details).toEqual([
    {kind: 'unscannable', cause: 'computedClassName'},
  ])
})

test('extracted class tokens feed the distribution', () => {
  expect(scanValues(`<div className={cn('px-3', extra)}/>`)).toEqual([
    {axis: 'horizontal', kind: 'padding', amount: {form: 'pixels', pixels: 12}, source: 'px-3'},
  ])
})

test('a computed position value makes positioning unscannable', () => {
  const source = `export function Fixture(mode: string, y: number) {\n  return <div style={{position: mode, top: y}}/>\n}\n`
  expect(scanSpacingSource('fixture.tsx', source).findings.map(finding => finding.detail)).toEqual([
    {kind: 'unscannable', cause: 'computedPosition'},
  ])
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

test('a custom class sharing a utility root is a known false positive', () => {
  expect(scanElements('<div className="absolute top-level-nav" style={{top: y}}/>').details).toEqual([
    {kind: 'offsetClassOnOwnedProperty', property: 'top', styleProperty: 'top', className: 'top-level-nav'},
  ])
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
  const scan = scanSpacingSource('fixture.tsx', source)
  expect(scan.inlineSpacedElements).toBe(2)
  expect(scan.findings.map(finding => [finding.line, finding.detail.kind])).toEqual([
    [3, 'offsetWithoutPosition'],
    [4, 'offsetWithoutPosition'],
  ])
})

function scanValues(elements: string): Array<Pick<SpacingValueSite, 'axis' | 'kind' | 'amount' | 'source'>> {
  const source = `export function Fixture(y: number) {\n  return <main>${elements}</main>\n}\n`
  return scanSpacingSource('fixture.tsx', source).values.map(({axis, kind, amount, source: written}) =>
    ({axis, kind, amount, source: written}))
}

test('class utilities contribute their amounts on the Tailwind scale', () => {
  expect(scanValues('<div className="mt-2.5"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'pixels', pixels: 10}, source: 'mt-2.5'},
  ])
  expect(scanValues('<div className="-mt-2"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'pixels', pixels: -8}, source: '-mt-2'},
  ])
  expect(scanValues('<div className="mb-px"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'pixels', pixels: 1}, source: 'mb-px'},
  ])
  expect(scanValues('<div className="p-4"/>')).toEqual([
    {axis: 'both', kind: 'padding', amount: {form: 'pixels', pixels: 16}, source: 'p-4'},
  ])
  expect(scanValues('<div className="gap-x-3 space-y-1"/>')).toEqual([
    {axis: 'horizontal', kind: 'gap', amount: {form: 'pixels', pixels: 12}, source: 'gap-x-3'},
    {axis: 'vertical', kind: 'gap', amount: {form: 'pixels', pixels: 4}, source: 'space-y-1'},
  ])
})

test('arbitrary values parse in px and rem; the rest stay as written', () => {
  expect(scanValues('<div className="mb-[13px]"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'pixels', pixels: 13}, source: 'mb-[13px]'},
  ])
  expect(scanValues('<div className="m-[0.5rem]"/>')).toEqual([
    {axis: 'both', kind: 'margin', amount: {form: 'pixels', pixels: 8}, source: 'm-[0.5rem]'},
  ])
  expect(scanValues('<div className="gap-[10%]"/>')).toEqual([
    {axis: 'both', kind: 'gap', amount: {form: 'keyword', text: '10%'}, source: 'gap-[10%]'},
  ])
})

test('variant-prefixed amounts are part of the vocabulary; auto margins are not amounts', () => {
  expect(scanValues('<div className="md:hover:mb-2"/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'pixels', pixels: 8}, source: 'md:hover:mb-2'},
  ])
  expect(scanValues('<div className="mt-auto mx-auto"/>')).toEqual([])
})

test('literal inline styles contribute amounts, names, and computed markers', () => {
  expect(scanValues('<div style={{marginTop: 8, rowGap: -4}}/>')).toEqual([
    {axis: 'vertical', kind: 'margin', amount: {form: 'pixels', pixels: 8}, source: 'marginTop'},
    {axis: 'vertical', kind: 'gap', amount: {form: 'pixels', pixels: -4}, source: 'rowGap'},
  ])
  expect(scanValues(`<div style={{padding: '12px', columnGap: '0.5rem'}}/>`)).toEqual([
    {axis: 'both', kind: 'padding', amount: {form: 'pixels', pixels: 12}, source: 'padding'},
    {axis: 'horizontal', kind: 'gap', amount: {form: 'pixels', pixels: 8}, source: 'columnGap'},
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
  const report = formatSpacingReport([{file: 'fixture.tsx', scan: scanSpacingSource('fixture.tsx', source)}], false)
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
  const report = formatSpacingReport([{file: 'fixture.tsx', scan: scanSpacingSource('fixture.tsx', source)}], false)
  expect(report).toContain('spacing values (Tailwind scale at 4px a step; named values are computed in TS):')
  expect(report).toContain('  vertical margin: 8px ×3 · 10px ×1 (fixture.tsx:6:5)')
  expect(report).toContain('  vertical gap: gap ×1 (fixture.tsx:7:5)')
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
    expect(result.stdout).toContain('spacing: 1 element spaced by inline styles across 2 scanned files; 2 findings (2 warnings, 0 notes).')
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
    expect(narrowed.stdout).toContain('No spacing findings.')
    expect(narrowed.stdout).toContain('spacing: 1 element spaced by inline styles across 1 scanned file; 0 findings (0 warnings, 0 notes).')

    const outside = runCli(directory, '--spacing', join('..', 'elsewhere.tsx'))
    expect(outside.exitCode).toBe(1)
    expect(outside.stderr).toContain('File not found')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
