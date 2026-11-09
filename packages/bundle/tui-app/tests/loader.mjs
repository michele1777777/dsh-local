/** Test-only TypeScript loader. No production service is mocked by this loader. */
import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve as resolvePath } from 'node:path'
const require = createRequire(import.meta.url)
const ts = require(process.env.DSH_TEST_TYPESCRIPT || 'typescript')
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const raw = await readFile(resolvePath(root, 'tsconfig.base.json'), 'utf8')
const aliases = ts.parseConfigFileTextToJson('tsconfig.base.json', raw).config.compilerOptions.paths
export async function resolve(specifier, context, next) {
  if (specifier === 'commander' && process.env.DSH_TEST_COMMANDER) return { url: pathToFileURL(require.resolve(process.env.DSH_TEST_COMMANDER)).href, shortCircuit: true }
  if (aliases[specifier]) {
    const target = resolvePath(root, aliases[specifier][0])
    const entry = (await stat(target)).isDirectory() ? resolvePath(target, 'index.ts') : target
    return { url: pathToFileURL(entry).href, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (!/\.tsx?$/.test(url)) return next(url, context)
  const source = await readFile(new URL(url), 'utf8')
  const result = ts.transpileModule(source, { fileName: fileURLToPath(url), compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  }, reportDiagnostics: true })
  if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n' }))
  return { format: 'module', source: result.outputText, shortCircuit: true }
}
