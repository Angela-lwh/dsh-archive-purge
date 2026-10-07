// Minimal app.asar reader: `node tools/asar.mjs list <archive>` or `... extract <archive> <innerPath> <outFile>`
import { open, readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const [, , cmd, archivePath, ...rest] = process.argv

/** Find the end (exclusive) of the first balanced JSON object in `text`. */
function jsonEnd(text) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

async function readHeader(archive) {
  const fh = await open(archive, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    await fh.read(sizeBuf, 0, 8, 0)
    // Header pickle: [payloadSize][valueSize][json bytes padded to 4]. The byte after
    // the two uint32s is where the JSON itself starts for every asar Electron writes.
    const raw = Buffer.alloc(8 + sizeBuf.readUInt32LE(4) + 8)
    await fh.read(raw, 0, raw.length, 0)
    const text = raw.toString('utf8')
    const start = text.indexOf('{')
    const end = jsonEnd(text.slice(start))
    if (end === -1) throw new Error('asar header not parsable')
    const header = JSON.parse(text.slice(start, start + end))
    const baseOffset = 8 + sizeBuf.readUInt32LE(4)
    return { fh, header, baseOffset }
  } catch (error) {
    await fh.close()
    throw error
  }
}

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (value.files) walk(value, p, out)
    else out.push({ path: p, size: value.size ?? 0, offset: value.offset === undefined ? undefined : Number(value.offset) })
  }
}

const { fh, header, baseOffset } = await readHeader(archivePath)
try {
  const files = []
  walk(header, '', files)
  if (cmd === 'list') {
    files.sort((a, b) => a.path.localeCompare(b.path))
    for (const f of files) process.stdout.write(`${String(f.size).padStart(10)}  ${f.path}\n`)
    process.stderr.write(`total ${files.length} files, baseOffset=${baseOffset}\n`)
  } else if (cmd === 'extract') {
    const [innerPath, outFile] = rest
    const entry = files.find((f) => f.path === innerPath)
    if (!entry) throw new Error(`not found: ${innerPath}`)
    const buf = Buffer.alloc(entry.size)
    await fh.read(buf, 0, entry.size, baseOffset + entry.offset)
    await mkdir(dirname(outFile), { recursive: true })
    await writeFile(outFile, buf)
    process.stdout.write(`wrote ${outFile} (${entry.size} bytes)\n`)
  } else if (cmd === 'extract-tree') {
    const [prefix, outDir] = rest
    let count = 0
    for (const entry of files) {
      if (!entry.path.startsWith(prefix)) continue
      const buf = Buffer.alloc(entry.size)
      await fh.read(buf, 0, entry.size, baseOffset + entry.offset)
      const target = `${outDir}/${entry.path}`
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buf)
      count++
    }
    process.stdout.write(`extracted ${count} files from ${prefix} into ${outDir}\n`)
  } else if (cmd === 'cat') {
    const [innerPath] = rest
    const entry = files.find((f) => f.path === innerPath)
    if (!entry) throw new Error(`not found: ${innerPath}`)
    const buf = Buffer.alloc(entry.size)
    await fh.read(buf, 0, entry.size, baseOffset + entry.offset)
    process.stdout.write(buf)
  } else {
    throw new Error(`unknown command: ${cmd}`)
  }
} finally {
  await fh.close()
}
