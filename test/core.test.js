'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Load the single source of truth: src/host.js. It is a plain function body
// (DSH evaluates it as `(async () => { <body> })()`), so:
//   1. the whole body must PARSE when wrapped as a function body;
//   2. the pure core between the PURE markers must evaluate to `hashlineCore`.
const hostPath = path.join(__dirname, '..', 'src', 'host.js')
const hostBody = fs.readFileSync(hostPath, 'utf8')

test('host.js parses as a function body (DSH precheck parity)', () => {
  // Mirrors dsh-cordis-host-runner precheckCode: (async () => { body })()
  assert.doesNotThrow(() => new Function(`(async () => {\n${hostBody}\n})()`))
})

test('host.js evaluates to a plugin without the sandbox `harness` global (static mount)', () => {
  // Mirrors index.js: `new Function(body)()` in a plain Node module context,
  // where `harness` is undefined — the environment-adaptation layer must pick
  // staticDefineTool + ctx.tools.register instead of harness.defineTool.
  const plugin = new Function(hostBody)()
  assert.equal(typeof plugin, 'object')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, undefined) // anonymous plugin object is fine
})

const PURE_START = '\n//PURE-CORE-START'
const PURE_END = '\n//PURE-CORE-END'
const startIdx = hostBody.indexOf(PURE_START)
const endIdx = hostBody.indexOf(PURE_END)
assert.ok(startIdx >= 0 && endIdx > startIdx, 'pure-core markers present')
// slice from the START marker line through the END marker line (inclusive)
const pureSection = hostBody.slice(startIdx + 1, endIdx + PURE_END.length)
const core = new Function(`${pureSection}\n; return hashlineCore`)()

const {
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
  applyEdit,
  changedRange,
  fmtRegion,
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
} = core

const HASH_PREFIX_RE = new RegExp(`^[A-Za-z0-9]{${HASH_LEN}}${HASH_SEP}`)

// ── xxh32 ────────────────────────────────────────────────────────────────
test('xxh32 matches known reference vectors', () => {
  assert.equal(xxh32(''), 0x02cc5d05)
  assert.equal(xxh32('a'), 0x550d7456)
  assert.equal(xxh32('abc'), 0x32d153ff)
  assert.equal(xxh32('hello world', 42), xxh32('hello world', 42)) // deterministic
  // seed changes the output
  assert.notEqual(xxh32('same input', 0), xxh32('same input', 1))
})

test('contentChecksum is stable and differs across contents', () => {
  const a = contentChecksum('line one\nline two\n')
  const b = contentChecksum('line one\nline two\n')
  const c = contentChecksum('line one\nline three\n')
  assert.equal(a, b)
  assert.notEqual(a, c)
})

// ── splitLines / canon ───────────────────────────────────────────────────
test('splitLines mirrors the Pi original semantics', () => {
  assert.deepEqual(splitLines(''), [''])
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']) // trailing newline: no phantom line
  assert.deepEqual(splitLines('\n\n'), ['', ''])
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a\r', 'b\r'])
})

test('canon strips CR and trailing whitespace', () => {
  assert.equal(canon('  hello  \r'), '  hello')
  assert.equal(canon('plain'), 'plain')
})

test('clipLine flattens newlines and caps length', () => {
  assert.equal(clipLine('a\nb'), 'a\\nb')
  assert.ok(clipLine('x'.repeat(500)).length < 250)
})

// ── lineHashesPure ───────────────────────────────────────────────────────
test('hashes are 3-char alphanumeric, deterministic, and unique per file', () => {
  const content = 'alpha\nbeta\ngamma\ndelta\n'
  const hashes = lineHashesPure(content)
  assert.equal(hashes.length, 4)
  for (const h of hashes) assert.match(h, HASH_RE)
  assert.equal(new Set(hashes).size, hashes.length)
  assert.deepEqual(lineHashesPure(content), hashes) // deterministic
})

test('blank-line runs still get unique hashes (probe assignment)', () => {
  const content = 'a\n\n\n\n\nb\n'
  const hashes = lineHashesPure(content)
  assert.equal(new Set(hashes).size, hashes.length)
  // consecutive blank lines exist
  const lines = splitLines(content)
  assert.ok(lines.includes(''))
})

test('large-ish file hashes quickly and uniquely', () => {
  const lines = []
  for (let i = 0; i < 5000; i++) lines.push(`line number ${i} with some content`)
  const hashes = lineHashesPure(lines.join('\n') + '\n')
  assert.equal(hashes.length, 5000)
  assert.equal(new Set(hashes).size, 5000)
})

// ── mapStableHashes ──────────────────────────────────────────────────────
test('mapStableHashes keeps untouched lines\' anchors stable across edits', () => {
  const oldContent = 'one\ntwo\nthree\nfour\nfive\n'
  const oldHashes = lineHashesPure(oldContent)
  // replace "three" with "THREE"
  const newContent = 'one\ntwo\nTHREE\nfour\nfive\n'
  const removed = new Set([oldHashes[2]])
  const newHashes = mapStableHashes(oldContent, oldHashes, newContent, removed)
  // untouched lines keep their exact anchors
  assert.equal(newHashes[0], oldHashes[0])
  assert.equal(newHashes[1], oldHashes[1])
  assert.equal(newHashes[3], oldHashes[3])
  assert.equal(newHashes[4], oldHashes[4])
  // all unique
  assert.equal(new Set(newHashes).size, newHashes.length)
})

test('mapStableHashes handles insertion (line count grows)', () => {
  const oldContent = 'a\nb\nc\n'
  const oldHashes = lineHashesPure(oldContent)
  const newContent = 'a\nb\nB2\nc\n'
  const removed = new Set([oldHashes[1]])
  const newHashes = mapStableHashes(oldContent, oldHashes, newContent, removed)
  assert.equal(newHashes.length, 4)
  assert.equal(newHashes[0], oldHashes[0])
  assert.equal(newHashes[3], oldHashes[2])
  assert.equal(new Set(newHashes).size, 4)
})

// ── parseText / parseHashRef / resEdit ───────────────────────────────────
test('parseText normalizes CRLF and blank-only replacements', () => {
  assert.deepEqual(parseText(''), [])
  assert.deepEqual(parseText('a\r\nb'), ['a', 'b'])
  assert.deepEqual(parseText('\n\n'), ['', ''])
  assert.deepEqual(parseText('x\n'), ['x', ''])
  assert.throws(() => parseText(['a']), /E_BAD_SHAPE/)
})

test('parseHashRef rejects line numbers, content, and prefixes', () => {
  assert.deepEqual(parseHashRef('aB3'), { hash: 'aB3' })
  assert.throws(() => parseHashRef('12: foo'), /E_BAD_REF/)
  assert.throws(() => parseHashRef('aB3│content'), /E_BAD_REF/)
  assert.throws(() => parseHashRef(''), /E_BAD_REF/)
})

test('resEdit auto-strips HASH│ prefixes from anchors with warnings', () => {
  const warnings = []
  const edit = resEdit({
    remove_from: 'xY9│line content',
    remove_to: 'aB3',
    replacement_text: 'new\nlines'
  }, warnings)
  assert.equal(edit.hash_bounds[0].hash, 'xY9')
  assert.equal(edit.hash_bounds[1].hash, 'aB3')
  assert.deepEqual(edit.content_lines, ['new', 'lines'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /E_BAD_REF/)
})

test('resEdit auto-strips diff markers (-/+ rows)', () => {
  const warnings = []
  const edit = resEdit({ remove_from: '+aB3│x', remove_to: '-cD4│y', replacement_text: 'z' }, warnings)
  assert.equal(edit.hash_bounds[0].hash, 'aB3')
  assert.equal(edit.hash_bounds[1].hash, 'cD4')
  assert.equal(warnings.length, 2)
})

// ── applyEdit ────────────────────────────────────────────────────────────
const SAMPLE = 'function hello() {\n  console.log("world");\n}\n\n// end\n'
const SAMPLE_HASHES = lineHashesPure(SAMPLE)

test('applyEdit replaces a range addressed by anchors', () => {
  const edit = {
    content_lines: ['  console.log("hi");'],
    hash_bounds: [{ hash: SAMPLE_HASHES[1] }, { hash: SAMPLE_HASHES[1] }]
  }
  const result = applyEdit(SAMPLE, edit, undefined, SAMPLE_HASHES)
  assert.equal(result.content, 'function hello() {\n  console.log("hi");\n}\n\n// end\n')
  assert.equal(result.firstChangedLine, 2)
  assert.equal(result.lastChangedLine, 2)
  assert.equal(result.noopEdit, undefined)
})

test('applyEdit rejects stale anchors with E_STALE_ANCHOR feedback', () => {
  const edit = {
    content_lines: ['x'],
    hash_bounds: [{ hash: 'ZZZ' }, { hash: 'ZZZ' }]
  }
  assert.throws(() => applyEdit(SAMPLE, edit, undefined, SAMPLE_HASHES), (err) => {
    assert.ok(err instanceof AnchorMismatchError)
    assert.match(err.message, /E_STALE_ANCHOR/)
    // feedback carries current context hashes (empty when no anchor resolved)
    assert.ok(Array.isArray(err.feedbackHashes))
    return true
  })
})

test('applyEdit rejects ambiguous anchors with E_AMBIGUOUS_ANCHOR', () => {
  // Force duplicate hashes by faking the hash list
  const fakeHashes = ['aB3', 'aB3', 'cD4']
  const edit = {
    content_lines: ['x'],
    hash_bounds: [{ hash: 'aB3' }, { hash: 'aB3' }]
  }
  assert.throws(() => applyEdit('a\nb\nc\n', edit, undefined, fakeHashes), (err) => {
    assert.ok(err instanceof AnchorMismatchError)
    assert.match(err.message, /E_AMBIGUOUS_ANCHOR/)
    return true
  })
})

test('applyEdit detects a noop (identical replacement)', () => {
  const edit = {
    content_lines: ['  console.log("world");'],
    hash_bounds: [{ hash: SAMPLE_HASHES[1] }, { hash: SAMPLE_HASHES[1] }]
  }
  const result = applyEdit(SAMPLE, edit, undefined, SAMPLE_HASHES)
  assert.equal(result.content, SAMPLE)
  assert.ok(result.noopEdit)
  assert.equal(result.firstChangedLine, undefined)
})

test('applyEdit refuses to empty a non-empty file', () => {
  const edit = {
    content_lines: [],
    hash_bounds: [{ hash: SAMPLE_HASHES[0] }, { hash: SAMPLE_HASHES[4] }]
  }
  assert.throws(() => applyEdit(SAMPLE, edit, undefined, SAMPLE_HASHES), /E_WOULD_EMPTY/)
})

test('applyEdit on an empty file inserts content via the single empty-line anchor', () => {
  const emptyHashes = lineHashesPure('')
  assert.equal(emptyHashes.length, 1)
  const edit = {
    content_lines: ['hello'],
    hash_bounds: [{ hash: emptyHashes[0] }, { hash: emptyHashes[0] }]
  }
  const result = applyEdit('', edit, undefined, emptyHashes)
  assert.equal(result.content, 'hello')
  assert.equal(result.firstChangedLine, 1)
  assert.equal(result.lastChangedLine, 1)
})

test('applyEdit swaps reversed ranges with a warning', () => {
  const edit = {
    content_lines: ['x'],
    hash_bounds: [{ hash: SAMPLE_HASHES[2] }, { hash: SAMPLE_HASHES[0] }]
  }
  const result = applyEdit(SAMPLE, edit, undefined, SAMPLE_HASHES)
  assert.equal(result.content, 'x\n\n// end\n')
  assert.ok(result.warnings.some((w) => /reversed/.test(w)))
})

test('applyEdit strips HASH│ prefixes pasted into replacement_text', () => {
  const edit = {
    content_lines: [`${SAMPLE_HASHES[1]}${HASH_SEP}  console.log("hi");`],
    hash_bounds: [{ hash: SAMPLE_HASHES[1] }, { hash: SAMPLE_HASHES[1] }]
  }
  const result = applyEdit(SAMPLE, edit, undefined, SAMPLE_HASHES)
  assert.equal(result.content, 'function hello() {\n  console.log("hi");\n}\n\n// end\n')
  assert.ok(result.warnings.some((w) => /E_BARE_HASH_PREFIX/.test(w)))
})

test('applyEdit enforces the served-range guard', () => {
  const served = new Set([SAMPLE_HASHES[0], SAMPLE_HASHES[3]])
  const edit = {
    content_lines: ['  console.log("hi");'],
    hash_bounds: [{ hash: SAMPLE_HASHES[1] }, { hash: SAMPLE_HASHES[1] }]
  }
  assert.throws(() => applyEdit(SAMPLE, edit, undefined, SAMPLE_HASHES, 'sample.js', served), (err) => {
    assert.ok(err instanceof RangeStaleError)
    assert.match(err.message, /E_RANGE_STALE/)
    assert.ok(err.rangeHashes.length > 0)
    return true
  })
})

test('stripBarePrefixes / stripDiffPrefixes are idempotent helpers', () => {
  const warnings = []
  const edit = {
    content_lines: [`${SAMPLE_HASHES[0]}${HASH_SEP}keep`, '+aB3│plus', '-cD4│minus'],
    hash_bounds: [{ hash: SAMPLE_HASHES[0] }, { hash: SAMPLE_HASHES[0] }]
  }
  const stripped = stripDiffPrefixes(stripBarePrefixes(edit, SAMPLE_HASHES, warnings), warnings)
  assert.deepEqual(stripped.content_lines, ['keep', 'plus', 'minus'])
  assert.equal(warnings.length, 2)
})

// ── changedRange / genDiff / fmtRegion ───────────────────────────────────
test('changedRange computes first/last changed lines', () => {
  assert.deepEqual(changedRange('a\nb\nc\n', 'a\nB\nc\n'), { firstChangedLine: 2, lastChangedLine: 2 })
  assert.equal(changedRange('a\nb\n', 'a\nb\n'), null)
  assert.deepEqual(changedRange('', 'x\ny\n'), { firstChangedLine: 1, lastChangedLine: 2 })
})

test('genDiff emits +/- rows with hash anchors', () => {
  const oldContent = 'one\ntwo\nthree\n'
  const oldHashes = lineHashesPure(oldContent)
  const newContent = 'one\nTWO\nthree\n'
  const newHashes = mapStableHashes(oldContent, oldHashes, newContent, new Set([oldHashes[1]]))
  const { diff, firstChangedLine } = genDiff(oldContent, newContent, 1, newHashes, oldHashes)
  assert.equal(firstChangedLine, 2)
  assert.match(diff, new RegExp(`-${oldHashes[1]}${HASH_SEP}two`))
  assert.match(diff, new RegExp(`\\+${newHashes[1]}${HASH_SEP}TWO`))
  assert.match(diff, new RegExp(` ${newHashes[0]}${HASH_SEP}one`))
  assert.match(diff, new RegExp(` ${newHashes[2]}${HASH_SEP}three`))
})

test('fmtRegion requires aligned hash/line arrays', () => {
  assert.equal(fmtRegion(['aB3'], ['x']), `aB3${HASH_SEP}x`)
  assert.throws(() => fmtRegion(['aB3'], ['x', 'y']))
})

// ── line endings / BOM ───────────────────────────────────────────────────
test('detectEnding / toLF / restoreEndings round-trip', () => {
  assert.equal(detectEnding('a\r\nb\r\n'), '\r\n')
  assert.equal(detectEnding('a\nb\n'), '\n')
  assert.equal(detectEnding('a\rb\r'), '\r')
  assert.equal(toLF('a\r\nb\rc'), 'a\nb\nc')
  assert.equal(restoreEndings('a\nb\n', '\r\n'), 'a\r\nb\r\n')
  assert.equal(restoreEndings('a\nb\n', '\r'), 'a\rb\r')
})

test('stripBOM separates the BOM from content', () => {
  assert.deepEqual(stripBOM('\uFEFFhello'), { bom: '\uFEFF', text: 'hello' })
  assert.deepEqual(stripBOM('hello'), { bom: '', text: 'hello' })
})

// ── end-to-end workflow simulation ───────────────────────────────────────
test('workflow: read → replace → chained replace → undo', () => {
  const content = 'line1\nline2\nline3\nline4\n'
  const hashes = lineHashesPure(content)

  // replace line2 (chained without re-reading)
  const removed = new Set([hashes[1]])
  const result1 = applyEdit(content, { content_lines: ['line2-edited'], hash_bounds: [{ hash: hashes[1] }, { hash: hashes[1] }] }, undefined, hashes)
  const result1Hashes = mapStableHashes(content, hashes, result1.content, removed)
  assert.equal(result1.content, 'line1\nline2-edited\nline3\nline4\n')

  // line3's anchor stayed put → chain a second edit
  const result2 = applyEdit(result1.content, { content_lines: ['line3-edited'], hash_bounds: [{ hash: result1Hashes[2] }, { hash: result1Hashes[2] }] }, undefined, result1Hashes)
  assert.equal(result2.content, 'line1\nline2-edited\nline3-edited\nline4\n')

  // undo back to the original via snapshots
  const undone = mapStableHashes(result2.content, result2.firstChangedLine === 3 ? lineHashesPure(result2.content) : [], content, new Set())
  assert.ok(undone.length === 4)
})
