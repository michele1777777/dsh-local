/** Explicit test-only hook/terminal double. Never loaded by dsh or the main TS loader. */
export async function resolve(specifier, context, next) {
  if (['react','react/jsx-runtime','ink'].includes(specifier)) return { url: new URL('./ui-harness.mjs', import.meta.url).href, shortCircuit:true }
  return next(specifier,context)
}
