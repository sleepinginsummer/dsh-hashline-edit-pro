'use strict'

// Static DSH plugin entry point.
//
// src/host.js is a self-contained JavaScript FUNCTION BODY (DSH evaluates it
// as `(async () => { <body> })()` in the dynamic-plugin sandbox, which injects
// the `harness` global). This wrapper evaluates the same body inside a plain
// Node module, where `harness` is absent — the body's environment-adaptation
// layer then builds tool definitions with its local staticDefineTool and
// registers them through ctx.tools, so the exact same source runs both as a
// dynamic plugin (cordis_define code.host) and as a statically mounted one
// (cordis.patch.yml row).
//
// The evaluation is deliberate: the body declares only function-scoped
// bindings and returns the plugin object, so `new Function(body)()` is safe
// and side-effect-free at load time.

const fs = require('node:fs')
const path = require('node:path')

const body = fs.readFileSync(path.join(__dirname, 'src', 'host.js'), 'utf8')
const plugin = new Function(body)()

module.exports = plugin
