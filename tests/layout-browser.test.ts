import {expect, test} from 'bun:test'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {findChromeExecutable, runLayoutSuite} from '../src/layout/chrome.ts'
import {parseLayoutSuite} from '../src/layout/config.ts'

const freerangeCli = fileURLToPath(new URL('../fr.ts', import.meta.url))

test.skipIf(findChromeExecutable() == null)('Chrome measures composed layout in each scenario', async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/failed') {
        return new Response(fixture(false), {status: 500, headers: {'content-type': 'text/html'}})
      }
      const withButton = path === '/with-button'
      return new Response(fixture(withButton, withButton), {headers: {'content-type': 'text/html'}})
    },
  })
  try {
    const suite = parseLayoutSuite({
      baseUrl: server.url.href,
      targets: [
        {name: 'composer', selector: '#composer'},
        {name: 'feed-content', selector: '#feed-content'},
        {name: 'sidebar-content', selector: '#sidebar-content'},
        {name: 'feed-track', selector: '#feed-track'},
        {name: 'sidebar-track', selector: '#sidebar-track'},
      ],
      scenarios: [
        {name: 'resting', url: '/resting', viewport: {width: 1440, height: 900}, readySelector: 'body'},
        {name: 'with-button', url: '/with-button', viewport: {width: 1440, height: 900}, readySelector: 'body'},
        {name: 'failed', url: '/failed', viewport: {width: 1440, height: 900}, readySelector: 'body'},
      ],
      constraints: [
        {
          kind: 'equalsPixels',
          name: 'resting composer height',
          target: 'composer',
          metric: {kind: 'size', axis: 'block'},
          pixels: 52,
          tolerancePx: 0.25,
          scenarios: ['resting', 'with-button', 'failed'],
        },
        {
          kind: 'align',
          name: 'content starts align',
          targets: ['feed-content', 'sidebar-content'],
          metric: {kind: 'edge', axis: 'block', edge: 'start'},
          tolerancePx: 0.5,
          scenarios: ['resting', 'with-button'],
        },
      ],
      inferAlignments: [{
        name: 'gallery columns',
        tracks: ['feed-track', 'sidebar-track'],
        axis: 'block',
        tolerancePx: 0.5,
        scenarios: ['resting', 'with-button', 'failed'],
      }],
    })
    const audit = await runLayoutSuite(suite)
    expect(audit.scenarios[0]?.checks.map(check => check.kind)).toEqual(['pass', 'pass'])
    expect(audit.scenarios[0]?.inferences).toEqual([{
      kind: 'aligned',
      scenario: 'resting',
      inference: 'gallery columns',
    }])
    expect(audit.scenarios[1]?.checks).toMatchObject([
      {
        kind: 'fail',
        rule: 'layout-size',
        measurements: [54],
        deltaPx: 2,
        contributors: [{label: 'prompt-scroll'}, {label: 'large-button'}],
      },
      {kind: 'fail', rule: 'layout-alignment', measurements: [154, 184], deltaPx: 30},
    ])
    expect(audit.scenarios[1]?.inferences[0]).toMatchObject({
      kind: 'candidate',
      confidence: 'strong',
      band: 'content',
      deltaPx: 30,
    })
    expect(audit.scenarios[2]?.checks[0]).toMatchObject({
      kind: 'unknown',
      reason: {kind: 'scenarioFailed'},
    })
    expect(audit.scenarios[2]?.inferences[0]).toMatchObject({
      kind: 'unknown',
      reason: {kind: 'scenarioFailed'},
    })
  } finally {
    await server.stop()
  }
}, 30_000)

test.skipIf(findChromeExecutable() == null)('fr --layout finds the project config and gates failed contracts', async () => {
  let withButton = false
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(fixture(withButton), {headers: {'content-type': 'text/html'}})
    },
  })
  const directory = mkdtempSync(join(tmpdir(), 'freerange-layout-cli-'))
  try {
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {jsx: 'preserve'},
      include: ['*.tsx'],
    }))
    writeFileSync(join(directory, 'Composer.tsx'), `
export const composer = <div data-fr-layout="composer" className="flex flex-col border">
  <div className="flex" style={{paddingTop: 11, paddingBottom: 11}}>
    <div style={{height: 30}} />
  </div>
</div>
`)
    writeFileSync(join(directory, 'freerange.layout.json'), JSON.stringify({
      baseUrl: server.url.href,
      targets: [{
        name: 'composer',
        selector: '[data-fr-layout="composer"]',
        source: {kind: 'jsx', file: 'Composer.tsx', marker: 'composer'},
      }],
      scenarios: [{
        name: 'with-button',
        url: '/',
        viewport: {width: 1440, height: 900},
        readySelector: 'body',
      }],
      constraints: [{
        kind: 'equalsPixels',
        name: 'resting composer height',
        target: 'composer',
        metric: {kind: 'size', axis: 'block'},
        pixels: 52,
        tolerancePx: 0.25,
        scenarios: ['with-button'],
      }],
    }))
    const failed = await runLayoutCli(directory)
    expect(failed.exitCode).toBe(1)
    expect(failed.stderr).toBe('')
    expect(failed.stdout).toContain('Static layout preflight:')
    expect(failed.stdout).toContain('computes to 54px; expected 52px ±0.25px')
    expect(failed.stdout).toContain('Rendered layout contracts:')
    expect(failed.stdout).toContain('with-button: all 1 constraints passed')

    writeFileSync(join(directory, 'Composer.tsx'), `
export const composer = <div data-fr-layout="composer" className="flex flex-col border">
  <div className="flex" style={{paddingTop: 10, paddingBottom: 10}}>
    <div style={{height: 30}} />
  </div>
</div>
`)
    withButton = true
    const renderedFailure = await runLayoutCli(directory)
    expect(renderedFailure.exitCode).toBe(1)
    expect(renderedFailure.stderr).toBe('')
    expect(renderedFailure.stdout).toContain('passed [layout-source-size] at 52px')
    expect(renderedFailure.stdout).toContain('with-button: error [layout-size]')

    writeFileSync(join(directory, 'Composer.tsx'), `
declare const runtimeClasses: string
export const composer = <div
  data-fr-layout="composer"
  className={runtimeClasses}
  style={{height: 52}}
/>
`)
    withButton = false
    const staticUnknown = await runLayoutCli(directory)
    expect(staticUnknown.exitCode).toBe(1)
    expect(staticUnknown.stderr).toBe('')
    expect(staticUnknown.stdout).toContain('unknown [layout-source-coverage]')
    expect(staticUnknown.stdout).toContain('with-button: all 1 constraints passed')

    writeFileSync(join(directory, 'Composer.tsx'), `
export const composer = <div data-fr-layout="composer" className="flex flex-col border">
  <div className="flex" style={{paddingTop: 11, paddingBottom: 11}}>
    <div style={{height: 30}} />
  </div>
</div>
`)
    withButton = true

    writeFileSync(join(directory, 'freerange.layout.json'), JSON.stringify({
      baseUrl: server.url.href,
      targets: [
        {
          name: 'composer',
          selector: '[data-fr-layout="composer"]',
          source: {kind: 'jsx', file: 'Composer.tsx', marker: 'composer'},
        },
        {name: 'feed-track', selector: '#feed-track'},
        {name: 'sidebar-track', selector: '#sidebar-track'},
      ],
      scenarios: [{
        name: 'with-button',
        url: '/',
        viewport: {width: 1440, height: 900},
        readySelector: 'body',
      }],
      constraints: [{
        kind: 'equalsPixels',
        name: 'current composer height',
        target: 'composer',
        metric: {kind: 'size', axis: 'block'},
        pixels: 54,
        tolerancePx: 0.25,
        scenarios: ['with-button'],
      }],
      inferAlignments: [{
        name: 'gallery columns',
        tracks: ['feed-track', 'sidebar-track'],
        axis: 'block',
        tolerancePx: 0.5,
        scenarios: ['with-button'],
      }],
    }))
    const suggested = await runLayoutCli(directory)
    expect(suggested.exitCode).toBe(0)
    expect(suggested.stderr).toBe('')
    expect(suggested.stdout).toContain('suggestion [layout-alignment-candidate]')
    expect(suggested.stdout).toContain('alignment inference: 0 aligned; 1 strong suggestion; 0 ambiguous; 0 unknown')
  } finally {
    rmSync(directory, {recursive: true, force: true})
    await server.stop()
  }
}, 30_000)

function fixture(withButton: boolean, delayedButton = false): string {
  const button = withButton && !delayedButton ? '<button id="large-button">Search</button>' : ''
  const script = withButton && delayedButton
    ? `<script>setTimeout(() => document.querySelector('#composer').insertAdjacentHTML('beforeend', '<button id="large-button">Search</button>'), 100)</script>`
    : ''
  return `<!doctype html>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; }
  #composer { display: flex; align-items: stretch; border-block: 1px solid; width: 400px; }
  #prompt-scroll { overflow-y: auto; padding-block: 10px; }
  #prompt-line { height: 30px; }
  button { height: 40px; }
  #large-button { height: 52px; }
  .track { position: relative; display: inline-block; width: 110px; height: 200px; vertical-align: top; }
  #feed-content, #sidebar-content { position: absolute; height: 50px; width: 100px; }
  #feed-content { top: 100px; }
  #sidebar-content { top: ${withButton ? 130 : 100}px; }
</style>
<div id="composer" data-fr-layout="composer">
  <div id="prompt-scroll"><div id="prompt-line">Prompt</div></div>
  <button>Send</button>
  ${button}
</div>
<div id="feed-track" class="track"><div id="feed-content" data-fr-layout-band="content"></div></div>
<div id="sidebar-track" class="track"><div id="sidebar-content" data-fr-layout-band="content"></div></div>
${script}`
}

async function runLayoutCli(cwd: string) {
  const subprocess = Bun.spawn([process.execPath, freerangeCli, '--layout'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  return {stdout, stderr, exitCode}
}
