/**
 * Install / uninstall @angela_lwh/dsh-archive-purge for one dsh profile.
 *
 * The plugin needs two things: its files somewhere the Host can import, and one
 * Loader row. Both live outside the profile's package manager on purpose — a
 * local plugin that a `pnpm install` may prune is a plugin that silently
 * disappears, and the profile's dependency closure is not the place for
 * machine-specific code.
 *
 * The row names the Host half by `file:` URL rather than by package name. DSH's
 * own client-module scanner documents `file:` and absolute entry names as
 * supported, and a URL needs no package manager, no link, and no lockfile edit.
 *
 * The patch edit is confined to a marker-delimited managed block, so repeated
 * runs replace that block instead of stacking rows, and uninstalling is a
 * deletion of exactly one marker pair.
 *
 * Usage:
 *   node install.mjs [--profile <name>] [--source <plugin dir>] [--dry-run]
 *   node install.mjs --uninstall [--profile <name>]
 */
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = '@angela_lwh/dsh-archive-purge'
const MARKER_START = '# >>> @angela_lwh/dsh-archive-purge (managed block) >>>'
const MARKER_END = '# <<< @angela_lwh/dsh-archive-purge (managed block) <<<'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const uninstall = argv.includes('--uninstall')
const profile = readOption('--profile') ?? process.env.DSH_PROFILE ?? 'desktop'
const source = resolve(readOption('--source') ?? join(HERE, 'plugin'))

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
if (home === '' || home === '.dsh') fail('could not determine DSH_HOME; set it explicitly')
const pluginDir = join(home, 'plugins', PACKAGE_NAME)
const patchFile = join(home, 'profiles', profile, 'cordis.patch.yml')

if (uninstall) {
  await uninstallPlugin()
} else {
  await installPlugin()
}

/** Copy the plugin next to dsh's own home and add its Loader row. */
async function installPlugin() {
  if (!existsSync(join(source, 'index.js')) || !existsSync(join(source, 'lib', 'client.js'))) {
    fail(`source does not look like the plugin: ${source}`)
  }
  if (!existsSync(patchFile)) fail(`profile patch file not found: ${patchFile}`)

  if (dryRun) {
    console.log(`[dry-run] would copy ${source} -> ${pluginDir}`)
    console.log(`[dry-run] would insert one Loader row for id archive-purge naming ${revisionedHostUrl(join(source, 'index.js'))}`)
    return
  }

  await rm(pluginDir, { recursive: true, force: true })
  await mkdir(dirname(pluginDir), { recursive: true })
  await cp(source, pluginDir, { recursive: true })
  // Both the row id and the module URL carry the freshly published bytes'
  // revision, and the revision is read AFTER the copy. Each half is load-bearing:
  // DSH's Loader does not re-evaluate a module for an entry whose id it already
  // knows (observed directly: a changed URL under a reused id produced no import
  // at all), and Node's ESM cache is keyed by URL, so a reused URL returns the
  // previous build. Revisioning both makes "reinstall" mean "the running process
  // picks up this build", with no restart and no churn while the bytes are
  // unchanged.
  const revision = createHash('sha256').update(readFileSync(join(pluginDir, 'index.js'))).digest('hex').slice(0, 12)
  const block = [
    MARKER_START,
    '# Managed by @angela_lwh/dsh-archive-purge/install.mjs — edit the block above instead of this line.',
    `# revision: ${revision}`,
    '- insert:',
    `    - id: archive-purge-${revision}`,
    `      name: '${toFileUrl(join(pluginDir, 'index.js'))}?rev=${revision}'`,
    MARKER_END,
  ].join('\n')
  await writeManagedBlock(block)
  console.log(`installed ${PACKAGE_NAME}`)
  console.log(`  files   ${pluginDir}`)
  console.log(`  row     ${patchFile}`)
  console.log(`  profile ${profile}`)
  console.log('\nReload the GUI page once (Ctrl+R) to pick up the new browser bundle.')
}

/** Remove the Loader row and the copied files. */
async function uninstallPlugin() {
  if (dryRun) {
    console.log(`[dry-run] would remove the managed block from ${patchFile}`)
    console.log(`[dry-run] would remove ${pluginDir}`)
    return
  }
  const existing = existsSync(patchFile) ? await readFile(patchFile, 'utf8') : undefined
  if (existing !== undefined && existing.includes(MARKER_START)) {
    await backup(patchFile)
    await writeFile(patchFile, stripManagedBlock(existing), 'utf8')
    console.log(`removed the Loader row from ${patchFile}`)
  } else {
    console.log(`no managed block in ${patchFile}`)
  }
  await rm(pluginDir, { recursive: true, force: true })
  console.log(`removed ${pluginDir}`)
  console.log('\nReload the GUI page once (Ctrl+R) to drop the browser bundle.')
}

/**
 * Write the managed block, retiring any previous row first.
 *
 * A single write that collapses the old row and adds the new one can leave the
 * previous instance alive long enough for both to register the same exact Fetch
 * route — and route paths are a composition-level contract, so the duplicate
 * throws and the new fiber fails. Reinstalling therefore retires the row, lets
 * the tree settle, and only then adds the replacement.
 *
 * @param block - the managed block to install.
 */
async function writeManagedBlock(block) {
  const existing = await readFile(patchFile, 'utf8')
  await backup(patchFile)
  if (!existing.includes(MARKER_START)) {
    await writeFile(patchFile, `${existing.replace(/\s*$/, '')}\n\n${block}\n`, 'utf8')
    return
  }
  await writeFile(patchFile, stripManagedBlock(existing), 'utf8')
  await sleep(1500)
  const settled = await readFile(patchFile, 'utf8')
  await writeFile(patchFile, `${settled.replace(/\s*$/, '')}\n\n${block}\n`, 'utf8')
}

/** Await a fixed delay so a retired Loader entry finishes disposing. */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** The file with its managed block swapped for `block`. */
function replaceManagedBlock(text, block) {
  const start = text.indexOf(MARKER_START)
  const end = text.indexOf(MARKER_END, start)
  if (start === -1 || end === -1) return text
  return `${text.slice(0, start)}${block}${text.slice(end + MARKER_END.length)}`
}

/** The file without any managed block. */
function stripManagedBlock(text) {
  return replaceManagedBlock(text, '').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n')
}

/** Keep one timestamped copy of the patch file before every write. */
async function backup(path) {
  const target = `${path}.bak-${new Date().toISOString().replace(/[:.]/gu, '-')}`
  await copyFile(path, target)
  console.log(`backed up ${path} -> ${target}`)
}

/** A `file:` URL spelling of an absolute path, valid for Node's ESM resolver. */
function toFileUrl(path) {
  return pathToFileURL(resolve(path)).href
}

/**
 * The row's module URL, stamped with a revision derived from the Host half's own
 * bytes.
 *
 * Node's ESM cache is keyed by URL, so re-pointing a live profile at the same file
 * would re-run the *cached* module — the previous implementation, not the one just
 * installed. A `?rev=` query makes the URL genuinely new while staying a valid
 * file URL that `fileURLToPath` (and therefore dsh's own package lookup) reads as
 * the plain path. Reinstalling therefore takes effect in a running process, and an
 * unchanged file keeps its revision instead of churning the Loader tree.
 *
 * @param path - the Host half's absolute path.
 * @returns a revisioned `file:` URL.
 */
function revisionedHostUrl(path) {
  const revision = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 12)
  return `${toFileUrl(path)}?rev=${revision}`
}

/** Read one `--flag value` argument. */
function readOption(flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

/** Report a fatal usage or environment problem. */
function fail(message) {
  console.error(`@angela_lwh/dsh-archive-purge install: ${message}`)
  process.exit(1)
}
