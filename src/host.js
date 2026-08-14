// dsh-hashline-edit-pro — Host half.
// ============================================================================
// This file is ONE self-contained JavaScript FUNCTION BODY: DSH evaluates it
// as `(async () => { <this file> })()` inside the dynamic-plugin sandbox and
// it must `return` a Cordis plugin object. It therefore:
//   • works verbatim as the `code.host` source for cordis_define, and
//   • is the single source of truth for test/core.test.js, which slices the
//     pure core between the //PURE-CORE-START / //PURE-CORE-END markers.
//
// Port of pi-hashline-edit-pro (npm) for the Pi coding agent, by the
// RimuruW pi-hashline-edit ecosystem. Every line of a file gets a unique
// 3-char content hash; edits target hashes, never line numbers.
//
// Registered model tools:
//   • hashline_read     — read a file as `HASH│content` rows (raw: true for plain)
//   • replace           — replace a line range addressed by two 3-char hashes
//   • undo_last_replace — revert the last replace on a file (survives restarts)
//
// The built-in DSH read/edit/write tools stay mounted; this plugin registers
// ADDITIVE tools (deviation from the Pi original, which replaces read/edit —
// the DSH sandbox cannot emit fs/observed or run the fs/write-intent
// waterfall, so shadowing the built-ins would break the observation policy).
// ============================================================================

//PURE-CORE-START
const HASH_LEN = 3
const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const ALPH_SIZE = ALPH.length // 62
const HASH_SPACE = Math.pow(ALPH_SIZE, HASH_LEN) // 238328
const HASH_RE = /^[A-Za-z0-9]{3}$/
const HASH_SEP = '│' // U+2502, same separator as the Pi original
const HASH_PROBE_STRIDE = ALPH_SIZE * ALPH_SIZE + ALPH_SIZE + 1 // 3907
const BITSET_WORDS = Math.ceil(HASH_SPACE / 32)
const MAX_RANGE_STALE_LINES = 100
const ANCHOR_ROW_RE = /^([+-]?)([A-Za-z0-9]{3})│/
const HL_BARE_PREFIX_RE = /^\s*([A-Za-z0-9]{3})│/
const HL_PREFIX_PLUS_RE = /^\+([A-Za-z0-9]{3})│/
const HL_PREFIX_MINUS_RE = /^-((?:[A-Za-z0-9]{3})│| {3}│)/
const textEncoder = new TextEncoder()

// ── xxh32 (pure JS replacement for xxhash-wasm; the Pi original uses xxh32) ──
const XXH_P1 = 2654435761
const XXH_P2 = 2246822519
const XXH_P3 = 3266489917
const XXH_P4 = 668265263
const XXH_P5 = 374761393
function u32(x) { return x >>> 0 }
function rotl(x, r) { return u32((x << r) | (x >>> (32 - r))) }
function xxh32(input, seed = 0) {
  const bytes = typeof input === 'string' ? textEncoder.encode(input) : input
  const n = bytes.length
  const read32 = (i) => u32(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24))
  const round = (v, inp) => u32(Math.imul(rotl(u32(v + u32(Math.imul(inp, XXH_P2))), 13), XXH_P1))
  let h32
  let i = 0
  if (n >= 16) {
    let v1 = u32(seed + XXH_P1 + XXH_P2)
    let v2 = u32(seed + XXH_P2)
    let v3 = u32(seed)
    let v4 = u32(seed - XXH_P1)
    const end = n - 16
    while (i <= end) {
      v1 = round(v1, read32(i)); i += 4
      v2 = round(v2, read32(i)); i += 4
      v3 = round(v3, read32(i)); i += 4
      v4 = round(v4, read32(i)); i += 4
    }
    h32 = u32(u32(rotl(v1, 1) + rotl(v2, 7)) + u32(rotl(v3, 12) + rotl(v4, 18)))
  } else {
    h32 = u32(seed + XXH_P5)
  }
  h32 = u32(h32 + n)
  while (i + 4 <= n) {
    h32 = u32(h32 + u32(Math.imul(read32(i), XXH_P3)))
    h32 = u32(Math.imul(rotl(h32, 17), XXH_P4))
    i += 4
  }
  while (i < n) {
    h32 = u32(h32 + u32(Math.imul(bytes[i], XXH_P5)))
    h32 = u32(Math.imul(rotl(h32, 11), XXH_P1))
    i += 1
  }
  h32 ^= h32 >>> 15
  h32 = u32(Math.imul(h32, XXH_P2))
  h32 ^= h32 >>> 13
  h32 = u32(Math.imul(h32, XXH_P3))
  h32 ^= h32 >>> 16
  return h32 >>> 0
}
/** 64-bit-ish content checksum for snapshot cache validation (two xxh32 seeds). */
function contentChecksum(content) {
  return xxh32(content, 0).toString(36) + '-' + xxh32(content, 0x9e3779b1).toString(36)
}

// ── Line handling ──
function splitLines(text) {
  if (text.length === 0) return ['']
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.slice(0, -1) : lines
}
function canon(line) { return line.replace(/\r/g, '').trimEnd() }
function clipLine(line, maxLen = 200) {
  const flat = line.replace(/\n/g, '\\n')
  return flat.length > maxLen ? `${flat.slice(0, maxLen)}...` : flat
}
function abortIf(signal) {
  if (signal && signal.aborted === true) throw new Error('Operation aborted')
}

// ── Hash assignment (content-derived base + open-addressing probe) ──
const hashCache = new Map()
function idxToHash(idx) {
  let out = ''
  for (let j = 0; j < HASH_LEN; j++) {
    out = ALPH[idx % ALPH_SIZE] + out
    idx = Math.floor(idx / ALPH_SIZE)
  }
  return out
}
function hashAt(idx) {
  let h = hashCache.get(idx)
  if (h === undefined) {
    h = idxToHash(idx)
    hashCache.set(idx, h)
  }
  return h
}
function getBit(bits, idx) { return ((bits[idx >>> 5] >>> (idx & 31)) & 1) !== 0 }
function setBit(bits, idx) { bits[idx >>> 5] |= 1 << (idx & 31) }
function nextZeroBit(bits, start) {
  let idx = start % HASH_SPACE
  for (let i = 0; i < HASH_SPACE; i++) {
    if (!getBit(bits, idx)) return idx
    idx += HASH_PROBE_STRIDE
    if (idx >= HASH_SPACE) idx -= HASH_SPACE
  }
  throw new Error(`[E_FILE_TOO_LARGE] Cannot allocate a unique hash anchor: the file exceeds the ${HASH_SPACE}-line limit for ${HASH_LEN}-char hashline anchors. For very large files use write or a non-line-based approach.`)
}
function assignHash(used, baseIdx, hint) {
  if (!getBit(used, baseIdx)) {
    setBit(used, baseIdx)
    hint.value = baseIdx + HASH_PROBE_STRIDE
    return hashAt(baseIdx)
  }
  const nextIdx = nextZeroBit(used, hint.value)
  setBit(used, nextIdx)
  hint.value = nextIdx + HASH_PROBE_STRIDE
  return hashAt(nextIdx)
}
/** Fresh per-line hashes for a whole file; deterministic for identical content. */
function lineHashesPure(content) {
  const lines = splitLines(content)
  const hashes = new Array(lines.length)
  const used = new Uint32Array(BITSET_WORDS)
  const hint = { value: 0 }
  for (let i = 0; i < lines.length; i++) {
    const c = canon(lines[i])
    const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE
    hashes[i] = assignHash(used, baseIdx, hint)
  }
  return hashes
}

// ── Stable hash mapping (anchors of untouched lines stay put after edits) ──
function hashToIndex(hash) {
  let idx = 0
  for (let j = 0; j < HASH_LEN; j++) {
    const charIdx = ALPH.indexOf(hash[j])
    if (charIdx < 0) return -1
    idx = idx * ALPH_SIZE + charIdx
  }
  return idx
}
function nearestNew(candidates, target) {
  let lo = 0
  let hi = candidates.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (candidates[mid] < target) lo = mid + 1
    else hi = mid
  }
  const left = lo - 1
  const right = lo
  if (left >= 0 && (right >= candidates.length || target - candidates[left] <= candidates[right] - target)) {
    return left
  }
  return right < candidates.length ? right : -1
}
function mapStableHashes(oldContent, oldHashes, newContent, removedHashes) {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  const newHashes = new Array(newLines.length)
  const used = new Uint32Array(BITSET_WORDS)
  const hint = { value: 0 }
  const removed = removedHashes ?? new Set()

  const oldHashIndex = new Map()
  for (let i = 0; i < oldHashes.length; i++) {
    const hash = oldHashes[i]
    oldHashIndex.set(hash, i)
    const idx = hashToIndex(hash)
    if (idx >= 0) setBit(used, idx)
  }

  const removedIndexes = new Set()
  for (const hash of removed) {
    const idx = oldHashIndex.get(hash)
    if (idx !== undefined) removedIndexes.add(idx)
  }

  let spanStart = oldLines.length
  let spanEnd = -1
  for (const idx of removedIndexes) {
    if (idx < spanStart) spanStart = idx
    if (idx > spanEnd) spanEnd = idx
  }
  const spanLen = spanEnd >= spanStart ? spanEnd - spanStart + 1 : 0
  const replacementLen = newLines.length - oldLines.length + spanLen
  const shiftAfterSpan = spanEnd >= spanStart ? replacementLen - spanLen : 0

  const survivors = []
  const removedEntries = []
  for (let i = 0; i < oldLines.length; i++) {
    const entry = { index: i, hash: oldHashes[i] }
    if (removedIndexes.has(i)) removedEntries.push(entry)
    else survivors.push(entry)
  }

  const newByContent = new Map()
  for (let i = 0; i < newLines.length; i++) {
    const key = canon(newLines[i])
    const list = newByContent.get(key)
    if (list) list.push(i)
    else newByContent.set(key, [i])
  }

  const markUsed = (hash) => {
    const idx = hashToIndex(hash)
    if (idx >= 0) {
      setBit(used, idx)
      if (idx + HASH_PROBE_STRIDE > hint.value) hint.value = idx + HASH_PROBE_STRIDE
    }
  }

  for (const entry of survivors) {
    const candidates = newByContent.get(canon(oldLines[entry.index]))
    if (!candidates || candidates.length === 0) continue
    const target = entry.index > spanEnd ? entry.index + shiftAfterSpan : entry.index
    const pos = nearestNew(candidates, target)
    if (pos < 0) continue
    const newIdx = candidates.splice(pos, 1)[0]
    newHashes[newIdx] = entry.hash
    markUsed(entry.hash)
  }

  const removedByContent = new Map()
  for (const entry of removedEntries) {
    const key = canon(oldLines[entry.index])
    let queue = removedByContent.get(key)
    if (!queue) {
      queue = { hashes: [], pos: 0 }
      removedByContent.set(key, queue)
    }
    queue.hashes.push(entry.hash)
  }

  for (let i = 0; i < newLines.length; i++) {
    if (newHashes[i]) continue
    const queue = removedByContent.get(canon(newLines[i]))
    if (!queue || queue.pos >= queue.hashes.length) continue
    newHashes[i] = queue.hashes[queue.pos]
    queue.pos += 1
  }

  for (let i = 0; i < newLines.length; i++) {
    if (newHashes[i]) continue
    const c = canon(newLines[i])
    const baseIdx = (xxh32(c) >>> 14) % HASH_SPACE
    newHashes[i] = assignHash(used, baseIdx, hint)
  }

  return newHashes
}

// ── Request parsing / normalization ──
function parseText(edit) {
  if (typeof edit !== 'string') {
    throw new Error('[E_BAD_SHAPE] "replacement_text" must be a string with \\n line separators, not an array. Do not pass an array of lines — pass the replacement text as one string: "line1\\nline2". Use "" to delete a range.')
  }
  const normalized = edit.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized === '') return []
  if (/^\n+$/.test(normalized)) return new Array(normalized.length).fill('')
  return normalized.split('\n')
}
function parseHashRef(ref) {
  const trimmed = ref.trim()
  if (trimmed.length === HASH_LEN && HASH_RE.test(trimmed)) return { hash: trimmed }
  if (trimmed.length === 0) {
    throw new Error('[E_BAD_REF] Invalid anchor. Expected a 3-char alphanumeric anchor (e.g. "aB3").')
  }
  if (/^\d+/.test(trimmed)) {
    throw new Error('[E_BAD_REF] Invalid anchor. Use the hash alone (e.g. "aB3") — no line numbers or trailing content.')
  }
  if (trimmed.includes('│')) {
    throw new Error(`[E_BAD_REF] Invalid anchor "${trimmed}". remove_from and remove_to must contain the 3-char hash only — remove everything from "│" onward.`)
  }
  throw new Error(`[E_BAD_REF] Invalid anchor "${trimmed}". Expected a 3-char alphanumeric anchor (e.g. "aB3").`)
}
function resEdit(edit, warnings) {
  const replaceLines = parseText(edit.replacement_text)
  const bounds = [edit.remove_from, edit.remove_to].map((ref) => {
    const trimmed = ref.trim()
    const match = trimmed.match(ANCHOR_ROW_RE)
    if (match) {
      let message
      if (match[1] === '+') {
        message = `[E_BAD_REF] Autocorrected: stripped diff-preview marker copied from the diff preview in remove_from/remove_to entry "${trimmed}".`
      } else if (match[1] === '-') {
        message = `[E_BAD_REF] Autocorrected: stripped leading "-" marker in remove_from/remove_to entry "${trimmed}".`
      } else {
        message = `[E_BAD_REF] Autocorrected: stripped "HASH│" prefix copied from read output in remove_from/remove_to entry "${trimmed}".`
      }
      warnings.push(message)
      return match[2]
    }
    return ref
  })
  return {
    content_lines: replaceLines,
    hash_bounds: [parseHashRef(bounds[0]), parseHashRef(bounds[1])]
  }
}
function stripBarePrefixes(edit, fileHashes, warnings) {
  const fileHashSet = new Set(fileHashes)
  const stripped = []
  const contentLines = edit.content_lines.map((line, lineIndex) => {
    const match = line.match(HL_BARE_PREFIX_RE)
    if (!match) return line
    stripped.push({ lineIndex, matched: fileHashSet.has(match[1]) })
    return line.slice(match[0].length)
  })
  if (stripped.length === 0) return edit
  const locations = stripped.map((s) => `replacement_text line ${s.lineIndex + 1}`).join(', ')
  const matchedCount = stripped.filter((s) => s.matched).length
  const evidence = matchedCount === 0
    ? 'none of the stripped hashes match current file lines'
    : `${matchedCount} of ${stripped.length} stripped hash(es) match current file lines`
  const guidance = matchedCount === 0
    ? ' Verify that these lines were pasted from read output; literal content starting with \'HASH│\' would be altered by this strip.'
    : ''
  warnings.push(`[E_BARE_HASH_PREFIX] Autocorrected: stripped "HASH│" prefix copied from read output in ${locations} (${evidence}).${guidance}`)
  return { ...edit, content_lines: contentLines }
}
function stripDiffPrefixes(edit, warnings) {
  const stripped = []
  const contentLines = edit.content_lines.map((line, lineIndex) => {
    const plus = line.match(HL_PREFIX_PLUS_RE)
    if (plus) {
      stripped.push(lineIndex)
      return line.slice(plus[0].length)
    }
    const minus = line.match(HL_PREFIX_MINUS_RE)
    if (minus) {
      stripped.push(lineIndex)
      return line.slice(minus[0].length)
    }
    return line
  })
  if (stripped.length === 0) return edit
  const locations = stripped.map((i) => `replacement_text line ${i + 1}`).join(', ')
  warnings.push(`[E_INVALID_PATCH] Autocorrected: stripped diff-preview marker copied from the diff preview in ${locations}.`)
  return { ...edit, content_lines: contentLines }
}
function swapReversedRanges(edit, fileHashes, warnings) {
  const lineByHash = new Map()
  for (let i = 0; i < fileHashes.length; i++) {
    lineByHash.set(fileHashes[i], i + 1)
  }
  const [startRef, endRef] = edit.hash_bounds
  const startLine = lineByHash.get(startRef.hash)
  const endLine = lineByHash.get(endRef.hash)
  if (startLine === undefined || endLine === undefined || startLine <= endLine) {
    return edit
  }
  warnings.push(`[E_BAD_OP] Autocorrected: remove_from and remove_to were reversed (remove_from ${startRef.hash} is after remove_to ${endRef.hash}); swapped the pair.`)
  return { ...edit, hash_bounds: [endRef, startRef] }
}

// ── Anchor validation ──
function buildIdx(content) {
  const fileLines = splitLines(content)
  const lineStarts = []
  let offset = 0
  for (let index = 0; index < fileLines.length; index++) {
    lineStarts.push(offset)
    offset += fileLines[index].length
    if (index < fileLines.length - 1) offset += 1
  }
  return { fileLines, lineStarts }
}
function resAnchorFromMap(ref, hashIndex) {
  const hashMatches = hashIndex.get(ref.hash)
  if (!hashMatches || hashMatches.length === 0) {
    return { ref, kind: 'not_found' }
  }
  if (hashMatches.length === 1) {
    return { line: hashMatches[0], hash: ref.hash, hashMatched: true }
  }
  return { ref, kind: 'ambiguous', candidates: hashMatches }
}
function assertAligned(fileLines, fileHashes, ctxLabel) {
  if (fileHashes.length !== fileLines.length) {
    throw new Error(`${ctxLabel}: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`)
  }
}
function fmtMismatchWithHashes(mismatches, fileLines, fileHashes, filePath) {
  assertAligned(fileLines, fileHashes, 'fmtMismatch')
  const out = []
  const hashes = []
  const notFound = mismatches.filter((m) => m.kind === 'not_found')
  const ambiguous = mismatches.filter((m) => m.kind === 'ambiguous')

  if (notFound.length > 0) {
    const refList = notFound.map((m) => `"${m.ref.hash}"`).join(', ')
    out.push(`[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? 's' : ''}${filePath ? ` in ${filePath}` : ''}: ${refList}. The file content has changed since those anchors were read. Call hashline_read to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into remove_from and remove_to of your next replace call.`)
    for (const m of notFound) {
      const ctxAnchor = m.context
      if (!ctxAnchor) continue
      const from = Math.max(1, ctxAnchor.line - 1)
      const to = Math.min(fileLines.length, ctxAnchor.line + 1)
      const rows = []
      for (let ln = from; ln <= to; ln++) {
        hashes.push(fileHashes[ln - 1])
        rows.push(`    ${ln}: ${fileHashes[ln - 1]}│${clipLine(fileLines[ln - 1] ?? '')}`)
      }
      out.push('')
      out.push(`  Current context around resolved anchor "${ctxAnchor.hash}" (line ${ctxAnchor.line}):\n${rows.join('\n')}`)
    }
  }
  if (ambiguous.length > 0) {
    if (out.length > 0) out.push('')
    out.push(`[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? 's' : ''}${filePath ? ` in ${filePath}` : ''}. Call hashline_read to get fresh anchors, then copy the 3-char HASH of the start and end of the range you are replacing into remove_from and remove_to of your next replace call.`)
    for (const m of ambiguous) {
      const sample = (m.candidates ?? []).slice(0, 5)
      const more = (m.candidates?.length ?? 0) > sample.length ? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)` : ''
      for (const line of sample) hashes.push(fileHashes[line - 1])
      const lines = sample.map((line) => {
        const content = clipLine(fileLines[line - 1] ?? '')
        return `    ${line}: ${fileHashes[line - 1]}│${content}`
      }).join('\n')
      out.push(`  Hash "${m.ref.hash}" matches lines ${sample.join(', ')}${more}.\n${lines}`)
    }
  }
  return { text: out.join('\n'), hashes }
}
function fmtMismatch(mismatches, fileLines, fileHashes, filePath) {
  return fmtMismatchWithHashes(mismatches, fileLines, fileHashes, filePath).text
}

class RangeStaleError extends Error {
  constructor(message, firstMismatchLine, rangeHashes) {
    super(message)
    this.name = 'RangeStaleError'
    this.firstMismatchLine = firstMismatchLine
    this.rangeHashes = rangeHashes
  }
}
class AnchorMismatchError extends Error {
  constructor(message, feedbackHashes) {
    super(message)
    this.name = 'AnchorMismatchError'
    this.feedbackHashes = feedbackHashes
  }
}

function findLastIndex(arr, predicate) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i
  }
  return -1
}
function trailingDups(contentLines, fileLines, endLine) {
  const start = lastNonEmptyIndex(contentLines)
  if (start < 0) return []
  const dups = []
  const maxK = Math.min(start + 1, fileLines.length - endLine)
  for (let k = 0; k < maxK; k++) {
    if (contentLines[start - k] !== fileLines[endLine + k]) break
    dups.push({ kind: 'trailing', replacementLineIndex: start - k })
  }
  return dups
}
function leadingDups(contentLines, fileLines, startLine) {
  const start = firstNonEmptyIndex(contentLines)
  if (start < 0) return []
  const dups = []
  const maxK = Math.min(contentLines.length - start, startLine - 1)
  for (let k = 0; k < maxK; k++) {
    if (contentLines[start + k] !== fileLines[startLine - 2 - k]) break
    dups.push({ kind: 'leading', replacementLineIndex: start + k })
  }
  return dups
}
function sectionIsUnique(canonLines, start, length) {
  let count = 0
  for (let i = 0; i + length <= canonLines.length; i++) {
    let k = 0
    while (k < length && canonLines[i + k] === canonLines[start + k]) k++
    if (k < length) continue
    count++
    if (count > 1) return false
  }
  return true
}
function firstNewAfterDups(contentLines, rangeLines, canonLines, endLine) {
  const firstNew = findNewEdge(contentLines, rangeLines, false)
  if (!firstNew) return []
  const maxK = Math.min(contentLines.length - firstNew.index, canonLines.length - endLine)
  let runLen = 0
  while (runLen < maxK && canon(contentLines[firstNew.index + runLen]) === canonLines[endLine + runLen]) {
    runLen++
  }
  if (runLen === 0 || !sectionIsUnique(canonLines, endLine, runLen)) return []
  const dups = []
  for (let k = 0; k < runLen; k++) {
    dups.push({ kind: 'first-new-after', replacementLineIndex: firstNew.index + k })
  }
  return dups
}
function lastNewBeforeDups(contentLines, rangeLines, canonLines, startLine) {
  const lastNew = findNewEdge(contentLines, rangeLines, true)
  if (!lastNew) return []
  const maxK = Math.min(lastNew.index + 1, startLine - 1)
  let runLen = 0
  while (runLen < maxK && canon(contentLines[lastNew.index - runLen]) === canonLines[startLine - 2 - runLen]) {
    runLen++
  }
  if (runLen === 0) return []
  const sectionStart = startLine - 1 - runLen
  if (!sectionIsUnique(canonLines, sectionStart, runLen)) return []
  const dups = []
  for (let k = 0; k < runLen; k++) {
    dups.push({ kind: 'last-new-before', replacementLineIndex: lastNew.index - k })
  }
  return dups
}
function canonCounts(lines) {
  const counts = new Map()
  for (const line of lines) {
    const key = canon(line)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}
function findNewEdge(contentLines, rangeLines, fromEnd) {
  const multiset = canonCounts(rangeLines)
  const step = fromEnd ? -1 : 1
  const start = fromEnd ? contentLines.length - 1 : 0
  for (let i = start; i >= 0 && i < contentLines.length; i += step) {
    const line = contentLines[i]
    if (line.length === 0) continue
    const key = canon(line)
    const count = multiset.get(key) ?? 0
    if (count > 0) {
      multiset.set(key, count - 1)
    } else {
      return { index: i, line }
    }
  }
  return undefined
}
function lastNonEmptyIndex(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > 0) return i
  }
  return -1
}
function firstNonEmptyIndex(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) return i
  }
  return -1
}
function valEdit(edit, fileLines, fileHashes, warnings, signal) {
  assertAligned(fileLines, fileHashes, 'valEdit')
  const mismatches = []
  const boundaryDups = []

  const hashIndex = new Map()
  for (let i = 0; i < fileHashes.length; i++) {
    const h = fileHashes[i]
    const list = hashIndex.get(h) ?? []
    list.push(i + 1)
    hashIndex.set(h, list)
  }

  const tryResolve = (ref) => {
    const result = resAnchorFromMap(ref, hashIndex)
    if ('kind' in result) {
      mismatches.push(result)
      return undefined
    }
    return result
  }

  abortIf(signal)
  const startResolved = tryResolve(edit.hash_bounds[0])
  const endResolved = tryResolve(edit.hash_bounds[1])
  if (!startResolved || !endResolved) {
    if (!startResolved && endResolved) {
      const startIdx = findLastIndex(mismatches, (m) => m.ref === edit.hash_bounds[0])
      const startMismatch = startIdx >= 0 ? mismatches[startIdx] : undefined
      if (startMismatch && startMismatch.kind === 'not_found') startMismatch.context = endResolved
    } else if (startResolved && !endResolved) {
      const endIdx = findLastIndex(mismatches, (m) => m.ref === edit.hash_bounds[1])
      const endMismatch = endIdx >= 0 ? mismatches[endIdx] : undefined
      if (endMismatch && endMismatch.kind === 'not_found') endMismatch.context = startResolved
    }
    return { resolved: undefined, mismatches, boundaryDups }
  }
  if (startResolved.line > endResolved.line) {
    throw new Error(`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.hash_bounds[0].hash} and ${edit.hash_bounds[1].hash}).`)
  }
  const endLine = endResolved.line
  const rangeLines = fileLines.slice(startResolved.line - 1, endLine)
  const canonLines = fileLines.map((line) => canon(line))
  boundaryDups.push(
    ...trailingDups(edit.content_lines, fileLines, endLine),
    ...leadingDups(edit.content_lines, fileLines, startResolved.line),
    ...firstNewAfterDups(edit.content_lines, rangeLines, canonLines, endLine),
    ...lastNewBeforeDups(edit.content_lines, rangeLines, canonLines, startResolved.line)
  )

  return {
    resolved: {
      content_lines: edit.content_lines,
      hash_bounds: [startResolved, endResolved]
    },
    mismatches,
    boundaryDups
  }
}
function assertRangeServed(resolved, fileLines, fileHashes, served, filePath) {
  assertAligned(fileLines, fileHashes, 'assertRangeServed')
  const startLine = resolved.hash_bounds[0].line
  const endLine = resolved.hash_bounds[1].line
  const mismatchLines = []
  for (let line = startLine; line <= endLine; line++) {
    if (!served.has(fileHashes[line - 1])) mismatchLines.push(line)
  }
  if (mismatchLines.length === 0) return

  const rangeLength = endLine - startLine + 1
  const shownLength = Math.min(rangeLength, MAX_RANGE_STALE_LINES)
  const rows = []
  const shownHashes = []
  for (let line = startLine; line < startLine + shownLength; line++) {
    const hash = fileHashes[line - 1]
    shownHashes.push(hash)
    rows.push(`${hash}${HASH_SEP}${fileLines[line - 1]}`)
  }
  const location = filePath ? ` in ${filePath}` : ''
  const first = mismatchLines[0]
  const mismatchText = mismatchLines.length === 1
    ? `Line ${first} of the replaced range (lines ${startLine}-${endLine})${location} does not match`
    : `${mismatchLines.length} of ${rangeLength} line(s) in the replaced range (lines ${startLine}-${endLine})${location} do not match`
  const capHint = rangeLength > shownLength
    ? `\n\n[The range has ${rangeLength} lines; showing the first ${shownLength}. Call hashline_read with offset=${startLine + shownLength} to see the rest.]`
    : ''
  const message = `[E_RANGE_STALE] ${mismatchText} what was previously shown: the file changed on disk after the anchors were read, or the line(s) were never shown. Nothing was modified. Current range with fresh anchors:\n\n${rows.join('\n')}${capHint}`
  throw new RangeStaleError(message, first, shownHashes)
}

// ── Applying the edit ──
function assertNotEmpty(originalContent, result) {
  if (originalContent.length > 0 && result.length === 0) {
    throw new Error('[E_WOULD_EMPTY] Cannot empty a non-empty file via replace. Use `write` if you need to clear the file.')
  }
}
function resToSpan(edit, content, lineIndex) {
  const { fileLines, lineStarts } = lineIndex
  const startLine = edit.hash_bounds[0].line
  const endLine = edit.hash_bounds[1].line
  const originalLines = fileLines.slice(startLine - 1, endLine)
  if (originalLines.length === edit.content_lines.length &&
      originalLines.every((line, index) => line === edit.content_lines[index])) {
    return {
      kind: 'noop',
      loc: edit.hash_bounds[0].hash,
      currentContent: originalLines.join('\n')
    }
  }
  if (edit.content_lines.length > 0) {
    return {
      kind: 'replace',
      start: lineStarts[startLine - 1],
      end: lineStarts[endLine - 1] + fileLines[endLine - 1].length,
      replacement: edit.content_lines.join('\n')
    }
  }
  if (startLine === 1 && endLine === fileLines.length) {
    return { kind: 'replace', start: 0, end: content.length, replacement: '' }
  }
  if (endLine < fileLines.length) {
    return {
      kind: 'replace',
      start: lineStarts[startLine - 1],
      end: lineStarts[endLine],
      replacement: ''
    }
  }
  if (content.endsWith('\n')) {
    return {
      kind: 'replace',
      start: lineStarts[startLine - 1],
      end: content.length,
      replacement: ''
    }
  }
  const prevLine = startLine >= 2 ? fileLines[startLine - 2] : undefined
  return {
    kind: 'replace',
    start: prevLine !== undefined && prevLine.length === 0
      ? lineStarts[startLine - 1]
      : Math.max(0, lineStarts[startLine - 1] - 1),
    end: content.length,
    replacement: ''
  }
}
function assemble(content, span, signal) {
  abortIf(signal)
  return content.slice(0, span.start) + span.replacement + content.slice(span.end)
}
function applyEdit(content, edit, signal, precomputedHashes, filePath, servedHashes) {
  abortIf(signal)
  const lineIndex = buildIdx(content)
  const fileHashes = precomputedHashes ?? lineHashesPure(content)
  const warnings = []

  const rangeFixed = swapReversedRanges(edit, fileHashes, warnings)
  const prefixFixed = stripDiffPrefixes(stripBarePrefixes(rangeFixed, fileHashes, warnings), warnings)

  const { resolved: initialResolved, mismatches, boundaryDups } = valEdit(prefixFixed, lineIndex.fileLines, fileHashes, warnings, signal)
  if (mismatches.length || !initialResolved) {
    const feedback = fmtMismatchWithHashes(mismatches, lineIndex.fileLines, fileHashes, filePath)
    throw new AnchorMismatchError(feedback.text, feedback.hashes)
  }

  let resolved = initialResolved
  let autoFixes
  if (boundaryDups.length > 0) {
    autoFixes = []
    const correctedEdit = { ...prefixFixed, content_lines: [...prefixFixed.content_lines] }
    const seen = new Set()
    const uniqueDups = []
    for (const dup of boundaryDups) {
      if (seen.has(dup.replacementLineIndex)) continue
      seen.add(dup.replacementLineIndex)
      uniqueDups.push(dup)
    }
    const dupsByIndex = uniqueDups.sort((a, b) => b.replacementLineIndex - a.replacementLineIndex)
    for (const dup of dupsByIndex) {
      const idx = dup.replacementLineIndex
      if (idx < 0 || idx >= correctedEdit.content_lines.length) continue
      const removed = correctedEdit.content_lines.splice(idx, 1)[0]
      autoFixes.push({ kind: dup.kind, removedLine: removed, removedLineIndex: idx })
    }
    const correctedResult = valEdit(correctedEdit, lineIndex.fileLines, fileHashes, warnings, signal)
    if (correctedResult.mismatches.length || !correctedResult.resolved) {
      const feedback = fmtMismatchWithHashes(correctedResult.mismatches, lineIndex.fileLines, fileHashes, filePath)
      throw new AnchorMismatchError(feedback.text, feedback.hashes)
    }
    resolved = correctedResult.resolved
  }

  if (servedHashes) {
    abortIf(signal)
    assertRangeServed(resolved, lineIndex.fileLines, fileHashes, servedHashes, filePath)
  }

  const spanResult = resToSpan(resolved, content, lineIndex)
  if (spanResult.kind === 'noop') {
    return {
      content,
      firstChangedLine: undefined,
      lastChangedLine: undefined,
      warnings,
      noopEdit: { loc: spanResult.loc, currentContent: spanResult.currentContent }
    }
  }

  const result = assemble(content, spanResult, signal)
  assertNotEmpty(content, result)
  const range = changedRange(content, result)

  return {
    content: result,
    firstChangedLine: range?.firstChangedLine,
    lastChangedLine: range?.lastChangedLine,
    warnings,
    ...(autoFixes ? { autoFixes } : {})
  }
}
function fmtRegion(hashes, lines) {
  if (hashes.length !== lines.length) {
    throw new Error(`fmtRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`)
  }
  return lines.map((line, index) => `${hashes[index]}${HASH_SEP}${line}`).join('\n')
}
function changedRange(original, result) {
  if (original === result) return null
  if (original.length === 0) {
    return { firstChangedLine: 1, lastChangedLine: splitLines(result).length }
  }
  const originalLines = splitLines(original)
  const resultLines = splitLines(result)
  if (originalLines.length === resultLines.length &&
      originalLines.every((line, index) => line === resultLines[index])) {
    return null
  }
  const minLen = Math.min(originalLines.length, resultLines.length)
  let first = 0
  while (first < minLen && originalLines[first] === resultLines[first]) first++
  let lastOrig = originalLines.length - 1
  let lastRes = resultLines.length - 1
  while (lastOrig >= first && lastRes >= first && originalLines[lastOrig] === resultLines[lastRes]) {
    lastOrig--
    lastRes--
  }
  return { firstChangedLine: first + 1, lastChangedLine: Math.max(first, lastRes) + 1 }
}

// ── Line-ending helpers ──
function detectEnding(content) {
  const lfIdx = content.indexOf('\n')
  if (lfIdx === -1) {
    return content.indexOf('\r') >= 0 ? '\r' : '\n'
  }
  const crlfIdx = content.indexOf('\r\n')
  if (crlfIdx === -1) return '\n'
  return crlfIdx < lfIdx ? '\r\n' : '\n'
}
function toLF(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}
function restoreEndings(text, ending) {
  if (ending === '\r\n') return text.replace(/\n/g, '\r\n')
  if (ending === '\r') return text.replace(/\n/g, '\r')
  return text
}
function stripBOM(content) {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content }
}

// ── Diff rendering (range-based; the replace op is one contiguous range) ──
function fmtDiffLine(prefix, line, hash) {
  if (hash === undefined) {
    return `${prefix}${' '.repeat(HASH_LEN)}${HASH_SEP}${line}`
  }
  return `${prefix}${hash}${HASH_SEP}${line}`
}
function diffRanges(oldLines, newLines) {
  const minLen = Math.min(oldLines.length, newLines.length)
  let first = 0
  while (first < minLen && oldLines[first] === newLines[first]) first++
  if (first === minLen && oldLines.length === newLines.length) return null
  let oldLast = oldLines.length - 1
  let newLast = newLines.length - 1
  while (oldLast >= first && newLast >= first && oldLines[oldLast] === newLines[newLast]) {
    oldLast--
    newLast--
  }
  return { first, oldLast, newLast }
}
function genDiff(oldContent, newContent, contextLines, newHashes, oldHashes) {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  const ranges = diffRanges(oldLines, newLines)
  if (ranges === null) return { diff: '', firstChangedLine: undefined }
  const { first, oldLast, newLast } = ranges
  const ctx = contextLines
  const output = []
  const ctxStart = Math.max(0, first - ctx)
  if (ctxStart > 0) output.push(' ...')
  for (let i = ctxStart; i < first; i++) {
    output.push(fmtDiffLine(' ', newLines[i], newHashes ? newHashes[i] : undefined))
  }
  for (let i = first; i <= oldLast; i++) {
    output.push(fmtDiffLine('-', oldLines[i], oldHashes ? oldHashes[i] : undefined))
  }
  for (let i = first; i <= newLast; i++) {
    output.push(fmtDiffLine('+', newLines[i], newHashes ? newHashes[i] : undefined))
  }
  const ctxEnd = Math.min(newLines.length - 1, newLast + ctx)
  for (let i = newLast + 1; i <= ctxEnd; i++) {
    output.push(fmtDiffLine(' ', newLines[i], newHashes ? newHashes[i] : undefined))
  }
  if (ctxEnd < newLines.length - 1) output.push(' ...')
  return { diff: output.join('\n'), firstChangedLine: first + 1 }
}

const hashlineCore = {
  xxh32,
  contentChecksum,
  splitLines,
  canon,
  clipLine,
  lineHashesPure,
  mapStableHashes,
  parseText,
  parseHashRef,
  resEdit,
  stripBarePrefixes,
  stripDiffPrefixes,
  swapReversedRanges,
  valEdit,
  fmtMismatchWithHashes,
  fmtMismatch,
  assertRangeServed,
  buildIdx,
  applyEdit,
  fmtRegion,
  changedRange,
  detectEnding,
  toLF,
  restoreEndings,
  stripBOM,
  genDiff,
  RangeStaleError,
  AnchorMismatchError,
  HASH_SEP,
  HASH_RE,
  HASH_LEN
}
//PURE-CORE-END

// ============================================================================
// Plugin
// ============================================================================
const READ_LIMIT = 2000
const SNIFF_BYTES = 8192
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_READ_LINE_BYTES = 200 * 1024
const MAX_OUTPUT_BYTES = 200 * 1024
const MAX_HASH_LINES = HASH_SPACE
const STATE_FILE = '.dsh-hashline-state.json'
const STATE_VERSION = 1
const SNAPSHOT_CAP = 256

function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function errMessage(error, fallback) {
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return fallback
}
function normPosInt(value, name) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`[E_BAD_SHAPE] Field "${name}" must be a positive integer.`)
  }
  return value
}

// ============================================================================
// Environment adaptation: the same body runs in two hosts.
//   • Dynamic plugin sandbox (cordis_define code.host) injects `harness`
//     (harness.defineTool / harness.registerTool) — marker-guarded.
//   • Static mount (index.js loads this body with `new Function`) runs inside
//     a plain Node plugin module where `harness` does not exist; tools then
//     register through ctx.tools with a definition built by staticDefineTool,
//     a minimal local equivalent of @deepseek-ai/dsh-tools defineTool (simple
//     scalar parameters only — no bundler or dependency resolution here).
// ============================================================================
function staticValidateAgainst(schema, value, path, violations) {
  if (schema === undefined || schema === true) return
  if (schema === false) { violations.push(`${path} is forbidden`); return }
  if (value === undefined) {
    if (schema.required === true) violations.push(`${path} is required`)
    return
  }
  const t = typeof value
  const want = schema.type
  let typeOk
  if (want === 'integer') typeOk = Number.isInteger(value)
  else if (want === 'number') typeOk = t === 'number'
  else if (want === 'string') typeOk = t === 'string'
  else if (want === 'boolean') typeOk = t === 'boolean'
  else if (want === 'null') typeOk = value === null
  else if (want === 'object') typeOk = value !== null && t === 'object' && !Array.isArray(value)
  else if (want === 'array') typeOk = Array.isArray(value)
  else typeOk = true
  if (!typeOk) { violations.push(`${path} must be of type ${want}`); return }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.join(', ')}`)
  }
  if (want === 'object' && value !== null && t === 'object' && !Array.isArray(value)) {
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key)) {
          violations.push(`${path}.${key} is not allowed`)
          break
        }
      }
    }
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      staticValidateAgainst(prop, value[key], `${path}.${key}`, violations)
    }
  }
  if (want === 'array' && Array.isArray(value) && schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      staticValidateAgainst(schema.items, value[i], `${path}[${i}]`, violations)
    }
  }
}
function staticDefineTool(options) {
  const properties = {}
  const required = []
  for (const [name, spec] of Object.entries(options.parameters ?? {})) {
    const prop = { type: spec.type }
    if (spec.description !== undefined) prop.description = spec.description
    if (spec.enum !== undefined) prop.enum = spec.enum.slice()
    if (spec.const !== undefined) prop.const = spec.const
    properties[name] = prop
    if (spec.required === true) required.push(name)
  }
  const parameters = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {})
  }
  // Mirror valueSchemaSpecToJsonSchema for the output schema: object-root
  // property-level `required: true` folds into the top-level `required` array.
  const outputSchema = options.output.schema
  if (outputSchema && outputSchema.type === 'object' && outputSchema.properties) {
    const outRequired = []
    const outProperties = {}
    for (const [name, prop] of Object.entries(outputSchema.properties)) {
      const copy = { ...prop }
      delete copy.required
      if (prop.required === true) outRequired.push(name)
      outProperties[name] = copy
    }
    outputSchema.properties = outProperties
    if (outRequired.length > 0) outputSchema.required = outRequired
  }
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value)
    },
    async execute(args, exec) {
      const violations = []
      staticValidateAgainst(parameters, args, 'value', violations)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    }
  }
  if (options.isConcurrencySafe !== undefined) {
    tool.isConcurrencySafe = (args) => {
      const violations = []
      staticValidateAgainst(parameters, args, 'value', violations)
      if (violations.length > 0) return false
      return options.isConcurrencySafe(args)
    }
  }
  return tool
}
const IS_SANDBOX = typeof harness !== 'undefined' && typeof harness.defineTool === 'function'
const defineTool = IS_SANDBOX ? harness.defineTool : staticDefineTool
function registerTool(ctxRef, tool) {
  if (IS_SANDBOX) return harness.registerTool(ctxRef, tool)
  return ctxRef.tools.register(tool)
}

return {
  // 静态挂载时 `fs` 由 dsh-fs-service 提供（cordis 服务），动态沙箱里由 harness 注入。
  // 声明依赖让 cordis 在服务挂载前保持 fiber pending（include 条目并行加载，顺序不保证）。
  inject: ['fs', 'tools'],
  apply(ctx) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('dsh-hashline-edit-pro: the fs service is not mounted')
    const systemPrompt = ctx.get('systemPrompt')
    const sandboxPolicyService = ctx.get('sandboxPolicy')

    // ── Persistent state (snapshots / served hashes / undo), keyed by displayPath ──
    const state = {
      loaded: false,
      path: undefined,
      snapshots: new Map(), // key → { checksum, lineCount, hashes }
      served: new Map(),   // key → Set<hash>
      undo: new Map(),     // key → { content, bom, ending, hashes, resultContent }
      dirty: false
    }

    function sessionCwd(exec) {
      return exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.cwd
        : undefined
    }
    function standingPolicy(exec) {
      if (sandboxPolicyService === undefined) return undefined
      return sandboxPolicyService.resolve({
        ...(exec.agent ? { session: exec.agent.session } : {})
      })
    }
    async function resolveWithCwd(path, exec, policy) {
      const root = policy && policy.workspaceRoot ? policy.workspaceRoot : sessionCwd(exec)
      return fs.resolve(path, {
        ...(root ? { cwd: root } : {}),
        signal: exec.signal
      })
    }
    function parseStateFile(raw) {
      try {
        const parsed = JSON.parse(raw)
        if (!isPlainRecord(parsed) || parsed.version !== STATE_VERSION) return
        if (isPlainRecord(parsed.snapshots)) {
          for (const [key, snap] of Object.entries(parsed.snapshots)) {
            if (isPlainRecord(snap) && typeof snap.checksum === 'string' && typeof snap.lineCount === 'number' && Array.isArray(snap.hashes)) {
              state.snapshots.set(key, { checksum: snap.checksum, lineCount: snap.lineCount, hashes: snap.hashes })
            }
          }
        }
        if (isPlainRecord(parsed.served)) {
          for (const [key, list] of Object.entries(parsed.served)) {
            if (Array.isArray(list)) state.served.set(key, new Set(list.filter((h) => typeof h === 'string')))
          }
        }
        if (isPlainRecord(parsed.undo)) {
          for (const [key, entry] of Object.entries(parsed.undo)) {
            if (isPlainRecord(entry) && typeof entry.content === 'string' && Array.isArray(entry.hashes)) {
              state.undo.set(key, {
                content: entry.content,
                bom: typeof entry.bom === 'string' ? entry.bom : '',
                ending: entry.ending === '\r\n' || entry.ending === '\r' ? entry.ending : '\n',
                hashes: entry.hashes,
                resultContent: typeof entry.resultContent === 'string' ? entry.resultContent : entry.content
              })
            }
          }
        }
      } catch (e) {
        // corrupt state file → start fresh
      }
    }
    async function loadState(exec) {
      if (state.loaded) return
      state.loaded = true
      const cwd = sessionCwd(exec)
      if (cwd === undefined) return
      try {
        const target = await fs.resolve(STATE_FILE, { cwd, signal: exec.signal })
        const raw = await fs.readText(target, exec.signal)
        state.path = target
        parseStateFile(raw)
      } catch (e) {
        try {
          state.path = await fs.resolve(STATE_FILE, { cwd, signal: exec.signal })
        } catch (e2) {
          state.path = undefined
        }
      }
    }
    async function saveState(exec) {
      if (!state.dirty || state.path === undefined) return
      state.dirty = false
      try {
        const payload = {
          version: STATE_VERSION,
          snapshots: Object.fromEntries(state.snapshots),
          served: Object.fromEntries([...state.served.entries()].map(([k, v]) => [k, [...v]])),
          undo: Object.fromEntries(state.undo)
        }
        await fs.writeText(state.path, JSON.stringify(payload), undefined, exec.signal, standingPolicy(exec))
      } catch (e) {
        state.dirty = true
        console.error(`dsh-hashline-edit-pro: failed to persist state: ${errMessage(e, String(e))}`)
      }
    }
    function putSnapshot(key, content, hashes) {
      state.snapshots.set(key, {
        checksum: contentChecksum(content),
        lineCount: splitLines(content).length,
        hashes
      })
      if (state.snapshots.size > SNAPSHOT_CAP) {
        const oldest = state.snapshots.keys().next().value
        state.snapshots.delete(oldest)
      }
      state.dirty = true
    }
    async function hashesFor(key, content, exec) {
      const checksum = contentChecksum(content)
      const lineCount = splitLines(content).length
      const snap = state.snapshots.get(key)
      if (snap && snap.checksum === checksum && snap.lineCount === lineCount) {
        return snap.hashes.slice()
      }
      const hashes = lineHashesPure(content)
      putSnapshot(key, content, hashes)
      await saveState(exec)
      return hashes
    }
    function servedSet(key) {
      return state.served.get(key)
    }
    function recordServed(key, hashes) {
      if (!Array.isArray(hashes) || hashes.length === 0) return
      let set = state.served.get(key)
      if (!set) {
        set = new Set()
        state.served.set(key, set)
      }
      let changed = false
      for (const h of hashes) {
        if (!set.has(h)) {
          set.add(h)
          changed = true
        }
      }
      if (changed) state.dirty = true
    }
    function recordServedFromDiff(key, diff) {
      const hashes = []
      for (const line of diff.split('\n')) {
        const match = /^[+ ]([A-Za-z0-9]{3})│/.exec(line)
        if (match) hashes.push(match[1])
      }
      recordServed(key, hashes)
    }

    // ── File kind sniffing ──
    function detectTextBom(sample) {
      if (sample.length >= 4 && sample[0] === 0xff && sample[1] === 0xfe && sample[2] === 0x00 && sample[3] === 0x00) return 'UTF-32LE'
      if (sample.length >= 4 && sample[0] === 0x00 && sample[1] === 0x00 && sample[2] === 0xfe && sample[3] === 0xff) return 'UTF-32BE'
      if (sample.length >= 2 && sample[0] === 0xff && sample[1] === 0xfe) return 'UTF-16LE'
      if (sample.length >= 2 && sample[0] === 0xfe && sample[1] === 0xff) return 'UTF-16BE'
      return undefined
    }
    function detectImageMagic(sample) {
      const len = sample.length
      if (len >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) return 'image/jpeg'
      if (len >= 8 && sample[0] === 0x89 && sample[1] === 0x50 && sample[2] === 0x4e && sample[3] === 0x47 && sample[4] === 0x0d && sample[5] === 0x0a && sample[6] === 0x1a && sample[7] === 0x0a) return 'image/png'
      if (len >= 6 && sample[0] === 0x47 && sample[1] === 0x49 && sample[2] === 0x46 && sample[3] === 0x38 && (sample[4] === 0x37 || sample[4] === 0x39) && sample[5] === 0x61) return 'image/gif'
      if (len >= 2 && sample[0] === 0x42 && sample[1] === 0x4d) return 'image/bmp'
      if (len >= 12 && sample[0] === 0x52 && sample[1] === 0x49 && sample[2] === 0x46 && sample[3] === 0x46 && sample[8] === 0x57 && sample[9] === 0x45 && sample[10] === 0x42 && sample[11] === 0x50) return 'image/webp'
      return undefined
    }
    function strictUtf8Decoder() {
      try {
        return new TextDecoder('utf-8', { fatal: true })
      } catch (e) {
        return undefined
      }
    }
    function sniffKind(sample) {
      const bom = detectTextBom(sample)
      if (bom !== undefined) return { kind: 'binary', description: `${bom} encoded text` }
      const mime = detectImageMagic(sample)
      if (mime !== undefined) return { kind: 'image', mimeType: mime }
      if (sample.includes(0)) return { kind: 'binary', description: 'binary file (NUL bytes)' }
      const strict = strictUtf8Decoder()
      if (strict !== undefined) {
        try {
          strict.decode(sample)
        } catch (e) {
          return { kind: 'binary', description: 'non-UTF-8 binary data' }
        }
      }
      return { kind: 'text' }
    }
    async function readRawText(fsRef, target, exec, displayPath) {
      const info = await fsRef.stat(target, exec.signal)
      if (info === undefined) throw new Error(`cannot read "${displayPath}": not found`)
      if (info.type !== 'file') throw new Error(`cannot read "${displayPath}": not a regular file`)
      if (info.size !== undefined && info.size > MAX_FILE_BYTES) {
        throw new Error(`[E_FILE_TOO_LARGE] ${displayPath} exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB size limit. Hashline editing targets source-sized files; for very large files use write or a non-line-based approach.`)
      }
      const sample = await fsRef.readBytes(target, exec.signal, SNIFF_BYTES)
      const sniffed = sniffKind(sample)
      if (sniffed.kind === 'image') {
        throw new Error(`[E_IMAGE] ${displayPath} is a ${sniffed.mimeType} image. Use the built-in read_image tool for images; hashline anchors address text lines.`)
      }
      if (sniffed.kind === 'binary') {
        throw new Error(`[E_BINARY] ${displayPath} looks like ${sniffed.description}. Hashline editing targets UTF-8 text files; use the built-in read/write tools for binary handling.`)
      }
      const text = await fsRef.readText(target, exec.signal)
      return { info, text }
    }

    // ── hashline_read ──
    const readTool = defineTool({
      name: 'hashline_read',
      description: 'Read a UTF-8 text file as HASH│content rows. Every line carries a unique 3-char alphanumeric hash (the line\'s address) — no line numbers. Use the hashes in replace calls (remove_from/remove_to). Anchors of lines you did not edit stay valid across replaces. Pass raw:true to get plain numbered content without anchors.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to the file to read (relative or absolute).'
        },
        offset: {
          type: 'number',
          description: '1-based first line to return. Defaults to 1.'
        },
        limit: {
          type: 'number',
          description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.`
        },
        raw: {
          type: 'boolean',
          description: 'When true, return plain line-numbered content without hash anchors (use for inspection, not editing).'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        abortIf(exec.signal)
        await loadState(exec)
        const target = await resolveWithCwd(args.path, exec, undefined)
        const displayPath = target.displayPath
        const { info, text: raw } = await readRawText(fs, target, exec, displayPath)
        void info
        const { bom, text } = stripBOM(raw)
        void bom
        const ending = detectEnding(text)
        const normalized = toLF(text)
        if (splitLines(normalized).length > MAX_HASH_LINES) {
          throw new Error(`[E_FILE_TOO_LARGE] ${displayPath} has more than ${MAX_HASH_LINES} lines, exceeding the hashline anchor limit. Use write or a non-line-based approach.`)
        }
        void ending

        const key = displayPath
        const allLines = splitLines(normalized)
        const total = allLines.length
        const offset = normPosInt(args.offset, 'offset') ?? 1
        const limit = Math.min(normPosInt(args.limit, 'limit') ?? READ_LIMIT, READ_LIMIT)
        const hadUtf8Errors = normalized.includes('\uFFFD')
        const servedHashes = []
        let totalBytes = 0
        const pushRow = (row) => {
          const bytes = textEncoder.encode(row).length
          if (totalBytes + bytes <= MAX_OUTPUT_BYTES) {
            totalBytes += bytes
            return true
          }
          return false
        }

        if (args.raw === true) {
          if (offset > total) {
            throw new Error(`Offset ${offset} is beyond end of file (${total} lines total). Use offset=1 to read from the start, or offset=${total} to read the last line.`)
          }
          const endIdx = Math.min(offset - 1 + limit, total)
          const rows = []
          let capped = false
          for (let i = offset - 1; i < endIdx; i++) {
            const line = allLines[i].length > 2000 ? `${allLines[i].slice(0, 2000)}... (line truncated to 2000 chars)` : allLines[i]
            const row = `${i + 1}: ${line}`
            if (!pushRow(row)) { capped = true; break }
            rows.push(row)
          }
          const endLine = offset + rows.length - 1
          let footer
          if (capped) footer = `(Output capped. Showing lines ${offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
          else if (endLine < total) footer = `(Showing lines ${offset}-${endLine} of ${total}. Use offset=${endLine + 1} to continue.)`
          else footer = `(End of file - total ${total} lines)`
          return {
            text: `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${rows.length > 0 ? `${rows.join('\n')}\n\n${footer}` : footer}\n</content>`
          }
        }

        const hashes = await hashesFor(key, normalized, exec)

        if (normalized === '') {
          const emptyHash = hashes[0] ?? ''
          recordServed(key, [emptyHash])
          await saveState(exec)
          return {
            text: `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${emptyHash}${HASH_SEP}\n[File is empty. Use replace to insert content.]\n</content>`
          }
        }
        if (offset > total) {
          throw new Error(`Offset ${offset} is beyond end of file (${total} lines total). Use offset=1 to read from the start, or offset=${total} to read the last line.`)
        }
        const endIdx = Math.min(offset - 1 + limit, total)
        const rows = []
        let capped = false
        for (let i = offset - 1; i < endIdx; i++) {
          const line = allLines[i]
          const hash = hashes[i]
          const rowBytes = textEncoder.encode(`${hash}${HASH_SEP}${line}`).length
          if (rowBytes > MAX_READ_LINE_BYTES) {
            const row = `[Line ${i + 1} is ${rowBytes} bytes, exceeds ${MAX_READ_LINE_BYTES}; content not shown because hashline anchors require full lines. Inspect with bash: sed -n '${i + 1}p' <path> | head -c ${MAX_READ_LINE_BYTES}]`
            if (!pushRow(row)) { capped = true; break }
            rows.push(row)
            continue
          }
          const row = `${hash}${HASH_SEP}${line}`
          if (!pushRow(row)) { capped = true; break }
          rows.push(row)
          servedHashes.push(hash)
        }
        const endLine = offset + rows.length - 1
        let footer
        if (capped) footer = `[Showing lines ${offset}-${endLine} of ${total} (${MAX_OUTPUT_BYTES} byte limit). Use offset=${endLine + 1} to continue.]`
        else if (endLine < total) footer = `[Showing lines ${offset}-${endLine} of ${total}. Use offset=${endLine + 1} to continue.]`
        else footer = `[End of file - total ${total} lines]`
        const outputText = `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${rows.length > 0 ? `${rows.join('\n')}\n\n${footer}` : footer}\n</content>${hadUtf8Errors ? '\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]' : ''}`

        recordServed(key, servedHashes)
        await saveState(exec)
        return { text: outputText }
      }
    })
    registerTool(ctx, readTool)

    // ── replace ──
    function mapWriteError(error, policy) {
      if (error && typeof error === 'object' && error.code === 'FS_SANDBOX_DENIED') {
        const mode = policy && policy.mode ? policy.mode : 'unknown'
        return new Error(`[sandbox: file access denied under ${mode} mode] — the replace was NOT applied. To escalate, use the built-in write tool with sandbox_permissions and justification.`)
      }
      return new Error(`replace failed: ${errMessage(error, String(error))}`)
    }
    function collectRemovedHashes(edit, originalHashes) {
      const removedHashes = new Set()
      const startHash = edit.hash_bounds[0].hash
      const endHash = edit.hash_bounds[1].hash
      const startLine = originalHashes.indexOf(startHash)
      const endLine = originalHashes.indexOf(endHash)
      if (startLine >= 0 && endLine >= 0) {
        const firstLine = Math.min(startLine, endLine)
        const lastLine = Math.max(startLine, endLine)
        for (let i = firstLine; i <= lastLine; i++) {
          removedHashes.add(originalHashes[i])
        }
      }
      return removedHashes
    }
    function countLineChanges(edit, originalHashes, isNoop, autoFixCount) {
      if (isNoop) return { totalAddedLines: 0, totalRemovedLines: 0 }
      let totalRemovedLines = 0
      const startLine = originalHashes.indexOf(edit.hash_bounds[0].hash)
      const endLine = originalHashes.indexOf(edit.hash_bounds[1].hash)
      if (startLine >= 0 && endLine >= 0) {
        totalRemovedLines = Math.abs(endLine - startLine) + 1
      }
      return {
        totalAddedLines: Math.max(0, edit.content_lines.length - (autoFixCount ?? 0)),
        totalRemovedLines
      }
    }
    function renderDiff(diff) {
      return diff.length === 0 ? '' : `\n\nDiff (HASH│anchored; "+" rows carry the fresh anchors for chained edits, "-" rows the removed lines):\n\n${diff}`
    }
    function renderWarnings(warnings) {
      return warnings.length > 0 ? `\n\nWarnings:\n${warnings.join('\n')}` : ''
    }

    const replaceTool = defineTool({
      name: 'replace',
      description: 'Replace a range of lines in a UTF-8 text file, targeted by the 3-char HASH anchors from hashline_read output. remove_from and remove_to must each be a BARE 3-character hash: copy only the hash from the leftmost column of a read row (row `ve7│function hello() {` means "remove_from": "ve7"). Never pass line content, code lines, or paragraphs into these fields. replacement_text is the new content as one string with \\n separators ("" deletes the range). The file must have been read with hashline_read first; stale anchors are rejected with fresh-anchor feedback.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to the file to edit (relative or absolute).'
        },
        remove_from: {
          type: 'string',
          required: true,
          description: 'Bare 3-char HASH only (e.g. "aB3") — marks the FIRST line to remove (inclusive).'
        },
        remove_to: {
          type: 'string',
          required: true,
          description: 'Bare 3-char HASH only (e.g. "aB3") — marks the LAST line to remove (inclusive).'
        },
        replacement_text: {
          type: 'string',
          required: true,
          description: 'Replacement text as a single string with \\n line separators; every \\n separates lines, so a trailing \\n adds a final empty line. Mirror the removed lines exactly, blank lines included. Use "" to delete the range.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.text }]
      },
      async execute(args, exec) {
        abortIf(exec.signal)
        await loadState(exec)
        const policy = standingPolicy(exec)
        const target = await resolveWithCwd(args.path, exec, policy)
        const displayPath = target.displayPath

        const warnings = []
        const edit = resEdit({
          remove_from: args.remove_from,
          remove_to: args.remove_to,
          replacement_text: args.replacement_text
        }, warnings)

        const { text: raw } = await readRawText(fs, target, exec, displayPath)
        const { bom, text } = stripBOM(raw)
        const ending = detectEnding(text)
        const original = toLF(text)
        const originalLines = splitLines(original)
        if (originalLines.length > MAX_HASH_LINES) {
          throw new Error(`[E_FILE_TOO_LARGE] ${displayPath} has more than ${MAX_HASH_LINES} lines, exceeding the hashline anchor limit. Use write or a non-line-based approach.`)
        }
        const key = displayPath
        const originalHashes = await hashesFor(key, original, exec)

        let applied
        try {
          const served = servedSet(key)
          applied = applyEdit(original, edit, exec.signal, originalHashes, displayPath, served)
        } catch (error) {
          if (error instanceof RangeStaleError) {
            recordServed(key, error.rangeHashes)
            await saveState(exec)
          } else if (error instanceof AnchorMismatchError) {
            recordServed(key, error.feedbackHashes)
            await saveState(exec)
          }
          throw error
        }

        const result = applied.content
        const isNoop = result === original
        for (const w of applied.warnings ?? []) warnings.push(w)
        if (isNoop) {
          const noopEdit = applied.noopEdit
          const text = noopEdit
            ? `No changes made to ${args.path}\nClassification: noop\nReplacement for ${noopEdit.loc} is identical to current content:\n  ${noopEdit.loc}: ${clipLine(noopEdit.currentContent)}`
            : `No changes made to ${args.path}\nClassification: noop\n\nThe edit produced identical content.`
          return { text }
        }

        const { totalAddedLines, totalRemovedLines } = countLineChanges(edit, originalHashes, false, applied.autoFixes ? applied.autoFixes.length : 0)

        // Persist undo BEFORE the write; roll back on write failure.
        const removedHashes = collectRemovedHashes(edit, originalHashes)
        const undoRecord = {
          content: original,
          bom,
          ending,
          hashes: originalHashes,
          resultContent: result
        }
        const prevUndo = state.undo.get(key)
        state.undo.set(key, undoRecord)
        state.dirty = true
        try {
          await saveState(exec)
        } catch (e) {
          warnings.push('[E_UNDO_UNAVAILABLE] Could not persist undo history; this edit will NOT be undoable after a restart.')
        }

        try {
          await fs.writeText(target, bom + restoreEndings(result, ending), undefined, exec.signal, policy)
        } catch (error) {
          if (prevUndo === undefined) state.undo.delete(key)
          else state.undo.set(key, prevUndo)
          state.dirty = true
          void saveState(exec)
          throw mapWriteError(error, policy)
        }

        const resultHashes = mapStableHashes(original, originalHashes, result, removedHashes)
        putSnapshot(key, result, resultHashes)
        const diff = genDiff(original, result, 1, resultHashes, originalHashes).diff
        recordServedFromDiff(key, diff)
        state.dirty = true
        await saveState(exec)

        const successPrefix = `Successfully replaced in ${args.path}.`
        const lineSummary = totalAddedLines > 0 || totalRemovedLines > 0
          ? ` Added ${totalAddedLines} line(s), removed ${totalRemovedLines} line(s).`
          : ''
        const outputText = `${successPrefix}${lineSummary}${renderWarnings(warnings)}${renderDiff(diff)}`
        return { text: outputText }
      }
    })
    registerTool(ctx, replaceTool)

    // ── undo_last_replace ──
    const undoTool = defineTool({
      name: 'undo_last_replace',
      description: 'Revert the last successful replace on a file, restoring its previous content. The undo record survives restarts (stored per workspace). Fails with [E_UNDO_STALE] when the file was modified after the replace or no longer exists.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Path to the file to undo (relative or absolute).'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true }
          }
        },
        render: (args, value) => [{ type: 'text', text: value.text }]
      },
      async execute(args, exec) {
        abortIf(exec.signal)
        await loadState(exec)
        const policy = standingPolicy(exec)
        const target = await resolveWithCwd(args.path, exec, policy)
        const displayPath = target.displayPath
        const key = displayPath

        const undoEntry = state.undo.get(key)
        if (!undoEntry) {
          return {
            text: `No undo history for ${args.path}. There is no previous replace to revert.`
          }
        }

        let currentRaw
        try {
          currentRaw = await fs.readText(target, exec.signal)
        } catch (e) {
          state.undo.delete(key)
          state.dirty = true
          await saveState(exec)
          return {
            text: `[E_UNDO_STALE] Cannot undo last replace on ${args.path}: the file no longer exists. Call hashline_read to inspect the current state.`
          }
        }

        if (currentRaw !== undoEntry.bom + restoreEndings(undoEntry.resultContent, undoEntry.ending)) {
          state.undo.delete(key)
          state.dirty = true
          await saveState(exec)
          return {
            text: `[E_UNDO_STALE] Cannot undo last replace on ${args.path}: the file was modified after the replace, so undoing would overwrite those changes. Call hashline_read to inspect the current state.`
          }
        }

        const { text: currentStripped } = stripBOM(currentRaw)
        const currentNormalized = toLF(currentStripped)
        const currentHashes = await hashesFor(key, currentNormalized, exec)
        const undoDiff = genDiff(currentNormalized, undoEntry.content, 1, undoEntry.hashes, currentHashes).diff

        try {
          await fs.writeText(target, undoEntry.bom + restoreEndings(undoEntry.content, undoEntry.ending), undefined, exec.signal, policy)
        } catch (error) {
          throw mapWriteError(error, policy)
        }

        state.undo.delete(key)
        putSnapshot(key, undoEntry.content, undoEntry.hashes)
        recordServedFromDiff(key, undoDiff)
        state.dirty = true
        await saveState(exec)

        const removedAdded = splitLines(undoEntry.resultContent).length - splitLines(undoEntry.content).length
        const parts = [
          `Undone last replace on ${args.path}.`,
          ...(removedAdded !== 0
            ? [`Removed ${Math.max(0, removedAdded)} line(s) that were added and restored ${Math.max(0, -removedAdded)} line(s) that were removed.`]
            : []),
          'File reverted to previous state. Call `hashline_read` to get fresh anchors for follow-up edits.'
        ]
        return { text: `${parts.join('\n')}${renderDiff(undoDiff)}` }
      }
    })
    registerTool(ctx, undoTool)

    // ── System-prompt guidance ──
    if (systemPrompt !== undefined) {
      systemPrompt.section({
        name: 'tool:hashline-edit-pro',
        order: 150,
        text: 'Hash-anchored editing is available: use hashline_read to read a file as HASH│content rows (unique 3-char anchors per line, no line numbers), then replace a line range with the replace tool using bare hashes in remove_from/remove_to. Anchors of untouched lines stay valid across replaces, so edits chain without re-reading. undo_last_replace reverts the last replace on a file. Pass raw:true to hashline_read for plain numbered output (inspection only). The built-in read/edit/write tools remain available for other purposes; prefer replace for targeted edits so stale-anchor corruption is impossible.'
      })
    }

    console.log('dsh-hashline-edit-pro: read/replace/undo tools registered')
  }
}
