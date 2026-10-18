/**
 * Keep the two manifests honest.
 *
 * `plugin/package.json` is the real package (what the Workshop submission pins and what
 * npm would publish); the repository-root `package.json` is a shim that makes
 * `dsh plugin add https://github.com/Angela-lwh/dsh-archive-purge` resolve to a real
 * bundle. Two manifests that name the same package can drift, so every shared field is
 * compared here and every path either of them declares is resolved on disk.
 *
 * Run it as part of the publish gate and in CI: `node tools/verify-package.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const check = (condition, message) => {
  if (!condition) problems.push(message)
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))
const rootManifest = read(join(ROOT, 'package.json'))
const packageManifest = read(join(ROOT, 'plugin', 'package.json'))

for (const field of ['name', 'version', 'description', 'license', 'type']) {
  check(rootManifest[field] === packageManifest[field],
    `root and plugin package.json disagree on "${field}": ${JSON.stringify(rootManifest[field])} vs ${JSON.stringify(packageManifest[field])}`)
}
check(JSON.stringify(rootManifest.dsh?.client) === JSON.stringify(packageManifest.dsh?.client),
  'root and plugin package.json disagree on dsh.client')
check(rootManifest.dsh?.manifestVersion === packageManifest.dsh?.manifestVersion,
  'root and plugin package.json disagree on dsh.manifestVersion')
check(JSON.stringify(rootManifest.engines) === JSON.stringify(packageManifest.engines),
  'root and plugin package.json disagree on engines')

/** Every relative path a manifest names has to exist, or the install fails at that step. */
function expectFile(base, relative, label) {
  const target = resolve(ROOT, base, relative)
  check(existsSync(target), `${label}: ${relative} does not exist (resolved to ${target})`)
}

// The root shim points into plugin/; the real package points at its own files.
expectFile('.', rootManifest.main, 'root main')
for (const [subpath, target] of Object.entries(rootManifest.exports ?? {})) {
  expectFile('.', target, `root exports["${subpath}"]`)
}
expectFile('.', rootManifest.dsh?.bundle?.patch, 'root dsh.bundle.patch')

expectFile('plugin', packageManifest.main, 'plugin main')
for (const [subpath, target] of Object.entries(packageManifest.exports ?? {})) {
  expectFile('plugin', target, `plugin exports["${subpath}"]`)
}
expectFile('plugin', packageManifest.dsh?.bundle?.patch, 'plugin dsh.bundle.patch')
for (const entry of packageManifest.files ?? []) expectFile('plugin', entry, 'plugin files')

// The client half is what the sidebar affordances come from; a missing one is silent.
expectFile('.', rootManifest.exports?.['./client'], 'root exports["./client"]')
expectFile('plugin', packageManifest.exports?.['./client'], 'plugin exports["./client"]')

// Locale files are read through the resolver, so a missing export means an English-only card.
for (const language of ['en', 'zh']) {
  expectFile('.', rootManifest.exports?.[`./locale/${language}.json`], `root locale export (${language})`)
  expectFile('plugin', packageManifest.exports?.[`./locale/${language}.json`], `plugin locale export (${language})`)
}

if (problems.length > 0) {
  console.error(`verify-package: ${String(problems.length)} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(`verify-package: root shim and plugin/package.json agree (${rootManifest.name}@${rootManifest.version})`)
}
