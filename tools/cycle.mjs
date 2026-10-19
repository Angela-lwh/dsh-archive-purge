/**
 * Force one fresh Host-side import of the plugin inside the running dsh process,
 * then print whatever the plugin's own activation diagnostic recorded.
 *
 * The profile's `patchReload: live` recomposes the Loader tree when
 * `cordis.patch.yml` changes, but a config-only change calls `fiber.update()`
 * and does NOT re-evaluate the module. Editing and re-importing a plugin while
 * developing it therefore needs a real entry change, which is what this script
 * does: it removes the managed row (disposing the entry and its ESM module), then
 * re-adds it pointing at an alternately named copy so the next import is keyed by
 * a URL the process has never seen.
 *
 * Usage: node tools/cycle.mjs [--profile <name>] [--keep]
 *   --keep  leave the row in place at the end (skip the second write's wait read)
 */
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = '@angela_lwh/dsh-archive-purge'
const MARKER_START = '# >>> @angela_lwh/dsh-archive-purge (managed block) >>>'
const MARKER_END = '# <<< @angela_lwh/dsh-archive-purge (managed block) <<<'


const argv = process.argv.slice(2)
const profile = readOption('--profile') ?? process.env.DSH_PROFILE ?? 'desktop'
const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const pluginDir = join(home, 'plugins', PACKAGE_NAME)
const patchFile = join(home, 'profiles', profile, 'cordis.patch.yml')
const logFile = join(pluginDir, 'boot.log')
const source = join(HERE, '..', 'plugin')

/** Stage 1: drop the row so the current entry (and its module) is disposed. */
await writePatch('')
console.log('row removed; waiting for the tree to settle')
await sleep(2000)

// Stage 2: publish the current source under an alternately named entry file AND
// an alternately named entry id. A failed fiber does not retry on a config
// change, and Node's ESM cache is keyed by URL, so a genuinely new evaluation
// needs both a new row id and a URL the process has never imported.
await copyFile(join(source, 'index.js'), join(pluginDir, 'index.js'))
const variant = readOption('--variant') ?? 'b'
if (!/^[a-z0-9]+$/u.test(variant)) throw new Error(`invalid variant ${variant}`)
const entryName = `entry-${variant}.js`
const entryId = `archive-purge-${variant}`
const entryFile = join(pluginDir, entryName)
await rm(entryFile, { force: true })
await copyFile(join(source, 'index.js'), entryFile)
await rm(logFile, { force: true })

const hostUrl = pathToFileURL(entryFile).href
const block = [
  MARKER_START,
  '- insert:',
  `    - id: ${entryId}`,
  `      name: '${hostUrl}'`,
  MARKER_END,
].join('\n')
await writePatch(block)
console.log(`row re-added as ${entryId} -> ${entryName}; waiting for import`)
await sleep(3000)

if (existsSync(logFile)) {
  console.log(`\n--- ${logFile} ---`)
  console.log(await readFile(logFile, 'utf8'))
} else {
  console.log(`\nno diagnostic log at ${logFile} (the module may not have been evaluated)`)
}

/** Replace the managed block with `block` (empty removes it). */
async function writePatch(block) {
  const text = await readFile(patchFile, 'utf8')
  const start = text.indexOf(MARKER_START)
  if (start === -1) {
    if (block === '') return
    await writeFile(patchFile, `${text.replace(/\s*$/, '')}\n\n${block}\n`, 'utf8')
    return
  }
  const end = text.indexOf(MARKER_END, start)
  const next = `${text.slice(0, start)}${block}${text.slice(end + MARKER_END.length)}`
  await writeFile(patchFile, next.replace(/\n{3,}/g, '\n\n'), 'utf8')
}

/** Read one `--flag value` argument. */
function readOption(flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

/** Await a fixed delay. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
