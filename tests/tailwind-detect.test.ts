import {afterAll, describe, expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {detectTailwind} from '../src/tailwind/core.ts'

const directories: string[] = []
afterAll(() => {
  for (const directory of directories) rmSync(directory, {recursive: true, force: true})
})

function project(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'freerange-detect-'))
  directories.push(directory)
  for (const [file, source] of Object.entries(files)) {
    const path = join(directory, file)
    mkdirSync(dirname(path), {recursive: true})
    writeFileSync(path, source)
  }
  return directory
}

describe('tailwind detection', () => {
  test('detects the dependency, a config file, or a stylesheet directive — and their absence', () => {
    expect(detectTailwind(project({
      'package.json': JSON.stringify({devDependencies: {tailwindcss: '^4'}}),
    }))).toMatchObject({detected: true})
    expect(detectTailwind(project({'tailwind.config.ts': 'export default {}\n'}))).toMatchObject({detected: true})
    expect(detectTailwind(project({
      'src/index.css': '@import "tailwindcss";\n.own { color: red; }\n',
    }))).toMatchObject({detected: true})
    expect(detectTailwind(project({
      'package.json': JSON.stringify({dependencies: {react: '^19'}}),
      'src/index.css': '.mb-2 { margin-bottom: 10px; }\n',
    }))).toMatchObject({detected: false})
  })
})
