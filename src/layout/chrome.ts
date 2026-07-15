import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {auditLayoutSnapshots} from './audit.ts'
import type {LayoutScenario, LayoutScenarioSnapshot, LayoutSuite, LayoutSuiteAudit, LayoutTarget} from './model.ts'
import {parseCapturedLayoutSnapshot} from './snapshot.ts'

const chromeStartupTimeoutMs = 10_000
const pageLoadTimeoutMs = 20_000
const layoutCaptureTimeoutMs = 15_000

export async function runLayoutSuite(suite: LayoutSuite, chromeExecutable = findChromeExecutable()): Promise<LayoutSuiteAudit> {
  if (chromeExecutable == null) {
    throw new Error('Could not find Chrome or Chromium. Set CHROME_PATH to its executable.')
  }
  const chrome = await launchChrome(chromeExecutable)
  const snapshots: LayoutScenarioSnapshot[] = []
  try {
    for (const scenario of suite.scenarios) {
      try {
        snapshots.push(await captureScenario(chrome.port, scenario, suite.targets))
      } catch (error) {
        snapshots.push({
          kind: 'failed',
          scenario: scenario.name,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } finally {
    chrome.process.kill()
    await chrome.process.exited
    rmSync(chrome.profileDirectory, {recursive: true, force: true})
  }
  return auditLayoutSnapshots(suite, snapshots)
}

export function findChromeExecutable(): string | null {
  const configured = process.env['CHROME_PATH']
  if (configured != null) return existsSync(configured) ? configured : null
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
        ]
  return candidates.find(existsSync) ?? null
}

type ChromeProcess = {
  port: number
  process: Bun.Subprocess<'ignore', 'ignore', 'ignore'>
  profileDirectory: string
}

async function launchChrome(executable: string): Promise<ChromeProcess> {
  const profileDirectory = mkdtempSync(join(tmpdir(), 'freerange-layout-chrome-'))
  const command = [
    executable,
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDirectory}`,
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-features=PaintHolding',
    '--force-device-scale-factor=1',
    '--no-default-browser-check',
    '--no-first-run',
    'about:blank',
  ]
  if (typeof process.getuid === 'function' && process.getuid() === 0) command.push('--no-sandbox')
  const chrome = Bun.spawn(command, {stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'})
  const activePortFile = join(profileDirectory, 'DevToolsActivePort')
  const deadline = Date.now() + chromeStartupTimeoutMs
  while (Date.now() < deadline) {
    if (existsSync(activePortFile)) {
      const firstLine = readFileSync(activePortFile, 'utf8').split(/\r?\n/, 1)[0]
      const port = Number(firstLine)
      if (Number.isInteger(port) && port > 0) return {port, process: chrome, profileDirectory}
    }
    if (chrome.exitCode != null) break
    await Bun.sleep(25)
  }
  chrome.kill()
  await chrome.exited
  rmSync(profileDirectory, {recursive: true, force: true})
  throw new Error(`Chrome did not open its debugging port within ${chromeStartupTimeoutMs}ms.`)
}

async function captureScenario(
  port: number,
  scenario: LayoutScenario,
  targets: LayoutTarget[],
): Promise<LayoutScenarioSnapshot> {
  const target = await createDebugTarget(port)
  const page = await CdpPage.connect(target.webSocketDebuggerUrl)
  try {
    await page.send('Page.enable')
    await page.send('Runtime.enable')
    await page.send('Network.enable')
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: scenario.viewport.width,
      height: scenario.viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    const documentResponses: DocumentResponse[] = []
    const stopCollectingResponses = page.onEvent('Network.responseReceived', value => {
      const response = documentResponse(value)
      if (response != null) documentResponses.push(response)
    })
    const loaded = page.waitForEvent('Page.loadEventFired', pageLoadTimeoutMs)
    const navigation = navigationResult(await page.send('Page.navigate', {url: scenario.url}))
    if (navigation.errorText != null) {
      void loaded.catch(() => {})
      throw new Error(`Navigation failed: ${navigation.errorText}`)
    }
    await loaded
    stopCollectingResponses()
    const mainResponse = documentResponses.findLast(response => response.frameID === navigation.frameID)
    if (mainResponse == null) throw new Error('Chrome reported no main-document response.')
    if (mainResponse.status < 200 || mainResponse.status >= 400) {
      throw new Error(`The scenario returned HTTP ${mainResponse.status} for ${mainResponse.url}.`)
    }
    const evaluated = await withTimeout(
      page.send('Runtime.evaluate', {
      expression: captureExpression(targets, scenario.readySelector),
        awaitPromise: true,
        returnByValue: true,
      }),
      layoutCaptureTimeoutMs,
      `The layout capture did not finish within ${layoutCaptureTimeoutMs}ms.`,
    )
    return parseCapturedLayoutSnapshot(runtimeEvaluationValue(evaluated), scenario.name)
  } finally {
    page.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(target.id)}`)
  }
}

type DebugTarget = {id: string; webSocketDebuggerUrl: string}

async function createDebugTarget(port: number): Promise<DebugTarget> {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: 'PUT'})
  if (!response.ok) throw new Error(`Chrome could not create a page (${response.status}).`)
  const value: unknown = await response.json()
  const target = record(value, 'Chrome target')
  const id = target['id']
  const webSocketDebuggerUrl = target['webSocketDebuggerUrl']
  if (typeof id !== 'string' || typeof webSocketDebuggerUrl !== 'string') {
    throw new Error('Chrome returned an invalid page target.')
  }
  return {id, webSocketDebuggerUrl}
}

class CdpPage {
  readonly #socket: WebSocket
  readonly #pending = new Map<number, {resolve: (value: unknown) => void; reject: (error: Error) => void}>()
  readonly #eventWaiters: Array<{
    method: string
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }> = []
  readonly #eventListeners: Array<{method: string; listener: (value: unknown) => void}> = []
  #nextID = 1

  private constructor(socket: WebSocket) {
    this.#socket = socket
    socket.addEventListener('message', event => this.receive(event.data))
    socket.addEventListener('close', () => this.rejectPending(new Error('Chrome closed the page connection.')))
    socket.addEventListener('error', () => this.rejectPending(new Error('Chrome page connection failed.')))
  }

  static async connect(url: string): Promise<CdpPage> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome page connection timed out.')), 5_000)
      socket.addEventListener('open', () => {
        clearTimeout(timeout)
        resolve()
      }, {once: true})
      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('Chrome page connection failed.'))
      }, {once: true})
    })
    return new CdpPage(socket)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextID++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {resolve, reject})
      this.#socket.send(JSON.stringify({id, method, params}))
    })
  }

  waitForEvent(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.#eventWaiters.findIndex(waiter => waiter.timeout === timeout)
        if (index >= 0) this.#eventWaiters.splice(index, 1)
        reject(new Error(`Chrome did not emit ${method} within ${timeoutMs}ms.`))
      }, timeoutMs)
      this.#eventWaiters.push({method, resolve, reject, timeout})
    })
  }

  onEvent(method: string, listener: (value: unknown) => void): () => void {
    const entry = {method, listener}
    this.#eventListeners.push(entry)
    return () => {
      const index = this.#eventListeners.indexOf(entry)
      if (index >= 0) this.#eventListeners.splice(index, 1)
    }
  }

  close(): void {
    this.#socket.close()
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') {
      this.rejectPending(new Error('Chrome returned a non-text protocol message.'))
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      this.rejectPending(new Error('Chrome returned an invalid protocol message.'))
      return
    }
    const message = record(parsed, 'Chrome protocol message')
    const id = message['id']
    if (typeof id === 'number') {
      const pending = this.#pending.get(id)
      if (pending == null) return
      this.#pending.delete(id)
      const protocolError = message['error']
      if (protocolError != null) {
        pending.reject(new Error(protocolErrorMessage(protocolError)))
      } else {
        pending.resolve(message['result'])
      }
      return
    }
    const method = message['method']
    if (typeof method !== 'string') return
    for (const listener of this.#eventListeners) {
      if (listener.method === method) listener.listener(message['params'])
    }
    for (let index = this.#eventWaiters.length - 1; index >= 0; index--) {
      const waiter = this.#eventWaiters[index]!
      if (waiter.method !== method) continue
      this.#eventWaiters.splice(index, 1)
      clearTimeout(waiter.timeout)
      waiter.resolve(message['params'])
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    for (const waiter of this.#eventWaiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.#eventWaiters.length = 0
  }
}

type NavigationResult = {frameID: string; errorText: string | null}

function navigationResult(value: unknown): NavigationResult {
  const result = record(value, 'Page.navigate response')
  const frameID = result['frameId']
  const errorText = result['errorText']
  if (typeof frameID !== 'string') throw new Error('Chrome returned no frame for the scenario navigation.')
  if (errorText !== undefined && typeof errorText !== 'string') {
    throw new Error('Chrome returned an invalid navigation error.')
  }
  return {frameID, errorText: errorText ?? null}
}

type DocumentResponse = {frameID: string; status: number; url: string}

function documentResponse(value: unknown): DocumentResponse | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return null
  const params = value as Record<string, unknown>
  if (params['type'] !== 'Document' || typeof params['frameId'] !== 'string') return null
  const rawResponse = params['response']
  if (typeof rawResponse !== 'object' || rawResponse == null || Array.isArray(rawResponse)) return null
  const response = rawResponse as Record<string, unknown>
  if (typeof response['status'] !== 'number' || typeof response['url'] !== 'string') return null
  return {frameID: params['frameId'], status: response['status'], url: response['url']}
}

function runtimeEvaluationValue(value: unknown): unknown {
  const response = record(value, 'Runtime.evaluate response')
  const result = record(response['result'], 'Runtime.evaluate response.result')
  const exception = response['exceptionDetails']
  if (exception != null) throw new Error('The layout capture script failed in the page.')
  if (!Object.hasOwn(result, 'value')) throw new Error('The layout capture script returned no value.')
  return result['value']
}

function protocolErrorMessage(value: unknown): string {
  const error = record(value, 'Chrome protocol error')
  return typeof error['message'] === 'string' ? error['message'] : 'Chrome protocol command failed.'
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) throw new Error(`${path} must be an object.`)
  return value as Record<string, unknown>
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timeout)
        resolve(value)
      },
      error => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function captureExpression(targets: LayoutTarget[], readySelector: string): string {
  const targetJSON = JSON.stringify(targets)
  const readySelectorJSON = JSON.stringify(readySelector)
  return `(async () => {
    const targets = ${targetJSON};
    const readySelector = ${readySelectorJSON};
    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    const rect = value => ({
      top: value.top,
      right: value.right,
      bottom: value.bottom,
      left: value.left,
      width: value.width,
      height: value.height,
    });
    const number = value => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const childBox = (element, parentSelector, index) => {
      const style = getComputedStyle(element);
      const label = element.getAttribute('data-fr-layout') || element.id || element.tagName.toLowerCase() + ':nth-child(' + (index + 1) + ')';
      return {
        label,
        selector: parentSelector + ' > :nth-child(' + (index + 1) + ')',
        position: style.position,
        rect: rect(element.getBoundingClientRect()),
        marginTop: number(style.marginTop),
        marginRight: number(style.marginRight),
        marginBottom: number(style.marginBottom),
        marginLeft: number(style.marginLeft),
      };
    };
    const box = (element, selector) => {
      const style = getComputedStyle(element);
      const principalRect = element.getClientRects().length === 0 ? null : rect(element.getBoundingClientRect());
      return {
        rect: principalRect,
        writingMode: style.writingMode,
        direction: style.direction,
        display: style.display,
        children: Array.from(element.children, (child, index) => childBox(child, selector, index)),
      };
    };
    const capture = () => ({
      targets: targets.map(target => {
        let matches;
        try {
          matches = Array.from(document.querySelectorAll(target.selector));
        } catch {
          return {target: target.name, selector: target.selector, invalidSelector: true, matches: []};
        }
        return {
          target: target.name,
          selector: target.selector,
          invalidSelector: false,
          matches: matches.map(element => box(element, target.selector)),
        };
      }),
    });
    const geometry = snapshot => snapshot.targets.flatMap(target => target.matches.flatMap(match => {
      const own = match.rect == null ? [] : Object.values(match.rect);
      const children = match.children.flatMap(child => Object.values(child.rect));
      return [...own, ...children];
    }));
    const equalGeometry = (left, right) => {
      const leftValues = geometry(left);
      const rightValues = geometry(right);
      return leftValues.length === rightValues.length
        && leftValues.every((value, index) => Math.abs(value - rightValues[index]) <= 0.25);
    };
    let readyCount = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        readyCount = document.querySelectorAll(readySelector).length;
      } catch {
        return {failure: 'ready selector ' + JSON.stringify(readySelector) + ' is invalid'};
      }
      if (readyCount === 1) break;
      await frame();
    }
    if (readyCount !== 1) {
      return {failure: 'ready selector ' + JSON.stringify(readySelector) + ' matched ' + readyCount + ' elements; exactly one is required'};
    }
    if (document.fonts != null) await document.fonts.ready;
    let previous = capture();
    let stableFrames = 0;
    for (let attempt = 0; attempt < 120; attempt++) {
      await frame();
      const current = capture();
      stableFrames = equalGeometry(previous, current) ? stableFrames + 1 : 0;
      if (stableFrames >= 15) return {...current, stable: true};
      previous = current;
    }
    return {...previous, stable: false};
  })()`
}
