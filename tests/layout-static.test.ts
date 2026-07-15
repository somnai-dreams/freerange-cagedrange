import {expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseLayoutSuite} from '../src/layout/config.ts'
import {formatStaticLayoutReport} from '../src/layout/report.ts'
import {runStaticLayoutSuite} from '../src/layout/static.ts'

const freerangeCli = fileURLToPath(new URL('../fr.ts', import.meta.url))

function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, source)
  }
}

function suite(file = 'Composer.tsx', pixels = 52) {
  return parseLayoutSuite({
    baseUrl: 'http://127.0.0.1:3000',
    targets: [{
      name: 'composer',
      selector: '[data-fr-layout="composer"]',
      source: {kind: 'jsx', file, marker: 'composer'},
    }],
    scenarios: [{
      name: 'resting',
      url: '/',
      viewport: {width: 1440, height: 900},
      readySelector: 'body',
    }],
    constraints: [{
      kind: 'equalsPixels',
      name: 'resting composer height',
      target: 'composer',
      metric: {kind: 'size', axis: 'block'},
      pixels,
      tolerancePx: 0.25,
      scenarios: ['resting'],
    }],
  })
}

function project(
  source: string,
  constants = '',
  pixels = 52,
): {directory: string; audit: ReturnType<typeof runStaticLayoutSuite>} {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-static-layout-'))
  writeFiles(directory, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'preserve',
      },
      include: ['*.ts', '*.tsx'],
    }),
    'constants.ts': constants,
    'Composer.tsx': source,
  })
  return {directory, audit: runStaticLayoutSuite(suite('Composer.tsx', pixels), directory)}
}

const passingComposer = `
export function Composer() {
  return <div data-fr-layout="composer" className="flex flex-col border">
    <div className="flex" style={{paddingTop: 10, paddingBottom: 10}}>
      <div style={{height: 30}} />
    </div>
  </div>
}
`

test('static block pressure proves an exact supported composer size', () => {
  const {directory, audit} = project(passingComposer)
  try {
    expect(audit.checks).toEqual([{
      kind: 'pass',
      constraint: 'resting composer height',
      target: 'composer',
      minimumPx: 52,
      maximumPx: 52,
    }])
    expect(formatStaticLayoutReport(audit)).toContain(
      'static layout contracts: 1/1 passed; 0 failed; 0 unknown',
    )
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('a conditional in-flow child creates a reachable 54px source failure', () => {
  const {directory, audit} = project(`
export function Composer({showExtra}: {showExtra: boolean}) {
  return <div data-fr-layout="composer" className="flex flex-col border">
    <div className="flex" style={{paddingTop: 10, paddingBottom: 10}}>
      <div style={{height: 30}} />
      {showExtra && <button className="h-8" />}
    </div>
  </div>
}
`)
  try {
    expect(audit.checks[0]).toMatchObject({
      kind: 'fail',
      minimumPx: 52,
      maximumPx: 54,
      witnessMinimumPx: 54,
    })
    const report = formatStaticLayoutReport(audit)
    expect(report).toContain('reachable branch requiring at least 54px')
    expect(report).toContain('when showExtra: explicit block size contributes 32px')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('a partially understood condition can still prove a reachable failure branch', () => {
  const {directory, audit} = project(`
declare function unknownFlag(): boolean
export function Composer({showExtra}: {showExtra: boolean}) {
  return <div data-fr-layout="composer" className="flex flex-col border">
    <div className="flex" style={{paddingTop: 10, paddingBottom: 10}}>
      <div style={{height: 30}} />
      {(unknownFlag() || showExtra) && <button className="h-8" />}
    </div>
  </div>
}
`)
  try {
    expect(audit.checks[0]).toMatchObject({
      kind: 'fail',
      witnessMinimumPx: 54,
    })
    expect(formatStaticLayoutReport(audit)).toContain(
      'when (unknownFlag() || showExtra): explicit block size contributes 32px',
    )
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('opaque component sizing stays unknown while a fixed wrapper and absolute overlay remain bounded', () => {
  const unknown = project(`
declare function ThirdPartyButton(): JSX.Element
export function Composer({showExtra}: {showExtra: boolean}) {
  return <div data-fr-layout="composer" className="flex flex-col border">
    <div className="flex" style={{paddingTop: 10, paddingBottom: 10}}>
      <div style={{height: 30}} />
      {showExtra && <ThirdPartyButton />}
    </div>
  </div>
}
`)
  try {
    expect(unknown.audit.checks[0]).toMatchObject({
      kind: 'unknown',
      minimumPx: 52,
      reason: {kind: 'unsupportedSource'},
    })
  } finally {
    rmSync(unknown.directory, {recursive: true, force: true})
  }

  const bounded = project(`
declare function ThirdPartyButton(): JSX.Element
export function Composer() {
  return <div data-fr-layout="composer" className="flex flex-col border">
    <div className="flex" style={{paddingTop: 10, paddingBottom: 10}}>
      <div style={{height: 30}} />
      <div className="absolute h-[200px]" />
      <div style={{height: 30}}><ThirdPartyButton /></div>
    </div>
  </div>
}
`)
  try {
    expect(bounded.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 52, maximumPx: 52})
  } finally {
    rmSync(bounded.directory, {recursive: true, force: true})
  }
})

test('imported constant arithmetic and resolved style objects reproduce MJ block pressure', () => {
  const {directory, audit} = project(`
import {inputPaddingYPills, pillsInputLineHeight} from './constants'
export function Composer({showControl}: {showControl: boolean}) {
  const rootStyle = {width: '100%', ...(showControl ? {zIndex: 1} : {})}
  return <div
    data-fr-layout="composer"
    className={\`flex border flex-col \${showControl ? 'relative' : ''}\`}
    style={rootStyle}
  >
    <div
      className="flex items-start"
      style={{paddingTop: inputPaddingYPills - 1, paddingBottom: inputPaddingYPills - 1}}
    >
      {showControl && <div style={{height: pillsInputLineHeight}} />}
    </div>
  </div>
}
`, `
export const inputMinLineHeight = 24
export const inputPaddingY = 15
export const inputMinInputHeight = inputMinLineHeight + inputPaddingY * 2
export const pillsInputLineHeight = 30
export const inputPaddingYPills = (inputMinInputHeight - pillsInputLineHeight) / 2
`)
  try {
    expect(audit.checks[0]).toMatchObject({
      kind: 'fail',
      witnessMinimumPx: 54,
    })
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('missing source files and duplicate markers are unknown coverage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-static-layout-coverage-'))
  try {
    writeFiles(directory, {
      'tsconfig.json': JSON.stringify({compilerOptions: {jsx: 'preserve'}, include: ['*.tsx']}),
      'Composer.tsx': `export const value = <><div data-fr-layout="composer"/><div data-fr-layout="composer"/></>`,
    })
    expect(runStaticLayoutSuite(suite(), directory).checks[0]).toMatchObject({
      kind: 'unknown',
      reason: {kind: 'sourceMarkerMatchedMultiple', count: 2},
    })
    expect(runStaticLayoutSuite(suite('Missing.tsx'), directory).checks[0]).toMatchObject({
      kind: 'unknown',
      reason: {kind: 'sourceFileMissing'},
    })
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('correlated sibling branches do not become a fabricated reachable maximum', () => {
  const {directory, audit} = project(`
export function Composer({showFirst}: {showFirst: boolean}) {
  return <div data-fr-layout="composer" className="flex flex-col">
    {showFirst && <div style={{height: 10}} />}
    {!showFirst && <div style={{height: 10}} />}
  </div>
}
`, '', 10)
  try {
    expect(audit.checks[0]).toMatchObject({
      kind: 'unknown',
      minimumPx: 0,
      maximumPx: 20,
      reason: {kind: 'unsupportedSource'},
    })
    expect(formatStaticLayoutReport(audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('parent and descendant conditions do not fabricate a combined pressure state', () => {
  const {directory, audit} = project(`
export function Composer({flag}: {flag: boolean}) {
  return <div
    data-fr-layout="composer"
    className={flag ? 'flex py-10' : 'flex'}
  >
    {!flag && <div className="h-20" />}
  </div>
}
`, '', 80)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'unknown'})
    expect(formatStaticLayoutReport(audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('stored aliases do not make contradictory boolean branches reachable', () => {
  const {directory, audit} = project(`
export function Composer({flag}: {flag: boolean}) {
  const first = flag
  const opposite = !flag
  return <div data-fr-layout="composer" className="flex">
    <div className="h-10" />
    {first && opposite && <div className="h-20" />}
  </div>
}
`, '', 40)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'unknown'})
    expect(formatStaticLayoutReport(audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }


  const nested = project(`
export function Composer({flag}: {flag: boolean}) {
  const first = flag
  const opposite = !flag
  return <div data-fr-layout="composer" className="flex flex-col">
    {first
      ? <div className="py-10">{opposite && <div className="h-20" />}</div>
      : <div className="h-20" />}
  </div>
}
`, '', 80)
  try {
    expect(nested.audit.checks[0]).toMatchObject({kind: 'unknown'})
    expect(formatStaticLayoutReport(nested.audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(nested.directory, {recursive: true, force: true})
  }


  const direct = project(`
export function Composer({flag}: {flag: boolean}) {
  return <div data-fr-layout="composer" className="flex">
    <div className="h-10" />
    {flag && !flag && <div className="h-20" />}
  </div>
}
`, '', 40)
  try {
    expect(direct.audit.checks[0]).toMatchObject({kind: 'unknown'})
    expect(formatStaticLayoutReport(direct.audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(direct.directory, {recursive: true, force: true})
  }
})

test('transparent JSX fragments preserve the parent flex direction', () => {
  const {directory, audit} = project(`
export const composer = <div data-fr-layout="composer" className="flex">
  <><div style={{height: 30}} /><div style={{height: 32}} /></>
</div>
`, '', 32)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 32, maximumPx: 32})
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('unreadable classes cannot turn an inline height into a definite source failure', () => {
  const {directory, audit} = project(`
declare const runtimeClasses: string
export const composer = <div data-fr-layout="composer" className={runtimeClasses} style={{height: 100}} />
`, '', 20)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'unknown', minimumPx: 0})
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('a marker inside a statically unreachable branch is coverage, not a failure', () => {
  const {directory, audit} = project(`
export const composer = false && <div data-fr-layout="composer" style={{height: 100}} />
`, '', 20)
  try {
    expect(audit.checks[0]).toMatchObject({
      kind: 'unknown',
      reason: {kind: 'unsupportedSource'},
    })
    expect(formatStaticLayoutReport(audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('a runtime-conditional source target cannot become an exact pass', () => {
  const {directory, audit} = project(`
export function Composer({show}: {show: boolean}) {
  return show && <div data-fr-layout="composer" className="h-10" />
}
`, '', 40)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('literal object properties prune unreachable JSX and hidden boxes', () => {
  const unreachableChild = project(`
const options = {show: false} as const
export const composer = <div data-fr-layout="composer" className="flex">
  <div className="h-10" />
  {options.show && <div className="h-20" />}
</div>
`, '', 40)
  try {
    expect(unreachableChild.audit.checks[0]).toMatchObject({
      kind: 'pass',
      minimumPx: 40,
      maximumPx: 40,
    })
  } finally {
    rmSync(unreachableChild.directory, {recursive: true, force: true})
  }

  const hiddenTarget = project(`
const options = {hidden: true} as const
export const composer = <div
  data-fr-layout="composer"
  hidden={options.hidden}
  className="h-20"
/>
`, '', 40)
  try {
    expect(hiddenTarget.audit.checks[0]).toMatchObject({kind: 'unknown'})
    expect(formatStaticLayoutReport(hiddenTarget.audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(hiddenTarget.directory, {recursive: true, force: true})
  }
})

test('later object spreads prevent literal-property branch pruning', () => {
  const spreadLast = project(`
declare function runtimeOptions(): {show: boolean}
const options = {show: false, ...runtimeOptions()}
export const composer = <div data-fr-layout="composer" className="flex">
  <div className="h-10" />
  {options.show && <div className="h-20" />}
</div>
`, '', 40)
  try {
    expect(spreadLast.audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(spreadLast.directory, {recursive: true, force: true})
  }

  const literalLast = project(`
declare function runtimeOptions(): {show: boolean}
const options = {...runtimeOptions(), show: false}
export const composer = <div data-fr-layout="composer" className="flex">
  <div className="h-10" />
  {options.show && <div className="h-20" />}
</div>
`, '', 40)
  try {
    expect(literalLast.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 40, maximumPx: 40})
  } finally {
    rmSync(literalLast.directory, {recursive: true, force: true})
  }
})

test('mutable const objects are not treated as immutable source facts', () => {
  const mutatedStyle = project(`
const composerStyle = {height: 40}
composerStyle.height = 80
export const composer = <div data-fr-layout="composer" style={composerStyle} />
`, '', 40)
  try {
    expect(mutatedStyle.audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(mutatedStyle.directory, {recursive: true, force: true})
  }

  const mutatedCondition = project(`
const options = {show: false}
options.show = true
export const composer = <div data-fr-layout="composer" className="flex">
  <div className="h-10" />
  {options.show && <div className="h-20" />}
</div>
`, '', 40)
  try {
    expect(mutatedCondition.audit.checks[0]).toMatchObject({kind: 'unknown'})
    expect(formatStaticLayoutReport(mutatedCondition.audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(mutatedCondition.directory, {recursive: true, force: true})
  }
})

test('cyclic immutable constants stop as unknown coverage', () => {
  const {directory, audit} = project(`
const first = second
const second = first
export const composer = <div data-fr-layout="composer" style={{height: first}} />
`)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('important height syntax and CSS min-over-max precedence stay exact', () => {
  const important = project(`
export const composer = <div data-fr-layout="composer" className="h-10!" />
`, '', 40)
  try {
    expect(important.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 40, maximumPx: 40})
  } finally {
    rmSync(important.directory, {recursive: true, force: true})
  }

  const clamped = project(`
export const composer = <div
  data-fr-layout="composer"
  style={{height: 80, minHeight: 100, maxHeight: 40}}
/>
`, '', 100)
  try {
    expect(clamped.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 100, maximumPx: 100})
  } finally {
    rmSync(clamped.directory, {recursive: true, force: true})
  }
})

test('content-box clamps the content before adding padding and borders', () => {
  const explicit = project(`
export const composer = <div
  data-fr-layout="composer"
  style={{
    boxSizing: 'content-box',
    height: 80,
    maxHeight: 40,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
  }}
/>
`, '', 62)
  try {
    expect(explicit.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 62, maximumPx: 62})
  } finally {
    rmSync(explicit.directory, {recursive: true, force: true})
  }

  const automatic = project(`
export const composer = <div
  data-fr-layout="composer"
  style={{boxSizing: 'content-box', minHeight: 40, paddingTop: 10, paddingBottom: 10}}
>
  <div style={{height: 30}} />
</div>
`, '', 60)
  try {
    expect(automatic.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 60, maximumPx: 60})
  } finally {
    rmSync(automatic.directory, {recursive: true, force: true})
  }
})

test('border-box cannot shrink below its padding and border chrome', () => {
  const {directory, audit} = project(`
export const composer = <div
  data-fr-layout="composer"
  style={{height: 10, paddingTop: 10, paddingBottom: 10}}
/>
`, '', 20)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 20, maximumPx: 20})
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('ancestor flex sizing cannot turn a local target size into a definite result', () => {
  const {directory, audit} = project(`
export const composer = <div style={{display: 'flex', flexDirection: 'column', height: 40}}>
  <div data-fr-layout="composer" style={{height: 80, minHeight: 0}} />
</div>
`, '', 40)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'unknown'})
    expect(formatStaticLayoutReport(audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }


  const rowStretch = project(`
export const composer = <div style={{display: 'flex', height: 80}}>
  <div data-fr-layout="composer" style={{display: 'flex', flexDirection: 'column'}}>
    <div style={{height: 40}} />
  </div>
</div>
`, '', 40)
  try {
    expect(rowStretch.audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(rowStretch.directory, {recursive: true, force: true})
  }

  const siblingStretch = project(`
export const composer = <div className="flex">
  <div data-fr-layout="composer" className="flex flex-col">
    <div className="h-10" />
  </div>
  <div className="h-20" />
</div>
`, '', 40)
  try {
    expect(siblingStretch.audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(siblingStretch.directory, {recursive: true, force: true})
  }


  const hiddenAncestor = project(`
export const composer = <div className="hidden">
  <div data-fr-layout="composer" className="h-10" />
</div>
`, '', 40)
  try {
    expect(hiddenAncestor.audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(hiddenAncestor.directory, {recursive: true, force: true})
  }

  const ordinaryAncestor = project(`
export const composer = <div>
  <div data-fr-layout="composer" className="h-10" />
</div>
`, '', 40)
  try {
    expect(ordinaryAncestor.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 40, maximumPx: 40})
  } finally {
    rmSync(ordinaryAncestor.directory, {recursive: true, force: true})
  }
})

test('non-replaced inline targets need an explicit block-capable display', () => {
  const inline = project(`
export const composer = <span data-fr-layout="composer" className="h-10" />
`, '', 40)
  try {
    expect(inline.audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(inline.directory, {recursive: true, force: true})
  }

  const block = project(`
export const composer = <span data-fr-layout="composer" className="block h-10" />
`, '', 40)
  try {
    expect(block.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 40, maximumPx: 40})
  } finally {
    rmSync(block.directory, {recursive: true, force: true})
  }
})

test('important Tailwind geometry overrides ordinary inline styles', () => {
  const {directory, audit} = project(`
export const composer = <div
  data-fr-layout="composer"
  className="!h-10"
  style={{height: 48}}
/>
`, '', 40)
  try {
    expect(audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 40, maximumPx: 40})
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('viewport variants are evaluated while runtime variants and overlapping utilities remain unknown', () => {
  const responsive = project(`
export const composer = <div data-fr-layout="composer" className="h-10 max-sm:hidden" />
`, '', 40)
  try {
    expect(responsive.audit.checks[0]).toMatchObject({kind: 'pass', minimumPx: 40, maximumPx: 40})
  } finally {
    rmSync(responsive.directory, {recursive: true, force: true})
  }

  const runtimeVariant = project(`
export const composer = <div data-fr-layout="composer" className="h-10 hover:h-20" />
`, '', 40)
  try {
    expect(runtimeVariant.audit.checks[0]).toMatchObject({kind: 'unknown', minimumPx: 0})
  } finally {
    rmSync(runtimeVariant.directory, {recursive: true, force: true})
  }

  const overlap = project(`
export const composer = <div data-fr-layout="composer" className="h-10 h-12" />
`, '', 48)
  try {
    expect(overlap.audit.checks[0]).toMatchObject({kind: 'unknown', minimumPx: 0})
  } finally {
    rmSync(overlap.directory, {recursive: true, force: true})
  }

  const arbitraryProperty = project(`
export const composer = <div data-fr-layout="composer" className="[height:48px]" />
`, '', 48)
  try {
    expect(arbitraryProperty.audit.checks[0]).toMatchObject({kind: 'unknown', minimumPx: 0})
  } finally {
    rmSync(arbitraryProperty.directory, {recursive: true, force: true})
  }

  const negativeMargin = project(`
export const composer = <div data-fr-layout="composer" className="flex flex-col">
  <div className="h-10 -mt-20" />
  <div className="h-10" />
</div>
`, '', 40)
  try {
    expect(negativeMargin.audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(negativeMargin.directory, {recursive: true, force: true})
  }

  const fullyOverriddenBase = project(`
export const composer = <div
  data-fr-layout="composer"
  className="h-20 sm:h-10 max-sm:h-10"
/>
`, '', 40)
  try {
    expect(fullyOverriddenBase.audit.checks[0]).toMatchObject({kind: 'unknown', minimumPx: 0})
    expect(formatStaticLayoutReport(fullyOverriddenBase.audit)).not.toContain('error [layout-source-size]')
  } finally {
    rmSync(fullyOverriddenBase.directory, {recursive: true, force: true})
  }
})

test('position affects parent pressure without erasing the target own box', () => {
  const positionedTarget = project(`
export const composer = <div data-fr-layout="composer" className="absolute h-10" />
`, '', 40)
  try {
    expect(positionedTarget.audit.checks[0]).toMatchObject({
      kind: 'pass',
      minimumPx: 40,
      maximumPx: 40,
    })
  } finally {
    rmSync(positionedTarget.directory, {recursive: true, force: true})
  }

  const hiddenTarget = project(`
export const composer = <div data-fr-layout="composer" className="hidden" />
`, '', 0)
  try {
    expect(hiddenTarget.audit.checks[0]).toMatchObject({
      kind: 'unknown',
      reason: {kind: 'unsupportedSource'},
    })
  } finally {
    rmSync(hiddenTarget.directory, {recursive: true, force: true})
  }

  const hiddenAttribute = project(`
export const composer = <div data-fr-layout="composer" hidden style={{height: 40}} />
`, '', 40)
  try {
    expect(hiddenAttribute.audit.checks[0]).toMatchObject({kind: 'unknown'})
  } finally {
    rmSync(hiddenAttribute.directory, {recursive: true, force: true})
  }
})

test('fr --layout-static finds the project config and gates source failures without Chrome', async () => {
  const {directory} = project(passingComposer)
  try {
    writeFileSync(join(directory, 'freerange.layout.json'), JSON.stringify({
      baseUrl: 'http://127.0.0.1:3000',
      targets: [{
        name: 'composer',
        selector: '[data-fr-layout="composer"]',
        source: {kind: 'jsx', file: 'Composer.tsx', marker: 'composer'},
      }],
      scenarios: [{
        name: 'resting',
        url: '/',
        viewport: {width: 1440, height: 900},
        readySelector: 'body',
      }],
      constraints: [{
        kind: 'equalsPixels',
        name: 'resting composer height',
        target: 'composer',
        metric: {kind: 'size', axis: 'block'},
        pixels: 51,
        tolerancePx: 0.25,
        scenarios: ['resting'],
      }],
    }))
    const subprocess = Bun.spawn([process.execPath, freerangeCli, '--layout-static'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
    expect(exitCode).toBe(1)
    expect(stderr).toBe('')
    expect(stdout).toContain('Static layout preflight:')
    expect(stdout).toContain('computes to 52px; expected 51px ±0.25px')
    expect(stdout).not.toContain('Rendered layout contracts:')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})

test('fr --layout prints a completed static phase before a Chrome startup error', async () => {
  const {directory} = project(passingComposer)
  try {
    writeFileSync(join(directory, 'freerange.layout.json'), JSON.stringify({
      baseUrl: 'http://127.0.0.1:3000',
      targets: [{
        name: 'composer',
        selector: '[data-fr-layout="composer"]',
        source: {kind: 'jsx', file: 'Composer.tsx', marker: 'composer'},
      }],
      scenarios: [{
        name: 'resting',
        url: '/',
        viewport: {width: 1440, height: 900},
        readySelector: 'body',
      }],
      constraints: [{
        kind: 'equalsPixels',
        name: 'resting composer height',
        target: 'composer',
        metric: {kind: 'size', axis: 'block'},
        pixels: 51,
        tolerancePx: 0.25,
        scenarios: ['resting'],
      }],
    }))
    const subprocess = Bun.spawn([process.execPath, freerangeCli, '--layout'], {
      cwd: directory,
      env: {...process.env, CHROME_PATH: '/definitely/not/chrome'},
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('Static layout preflight:')
    expect(stdout).toContain('computes to 52px; expected 51px ±0.25px')
    expect(stderr).toContain('Could not find Chrome or Chromium')
  } finally {
    rmSync(directory, {recursive: true, force: true})
  }
})
