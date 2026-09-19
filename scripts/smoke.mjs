#!/usr/bin/env node
/**
 * Release smoke test: pack the package the way the host would, then verify the
 * tarball is self-consistent AND that the packed mod actually works.
 *
 * Checks:
 *   - required files are present in the tarball
 *   - `commandcode.mods` is declared and every entry resolves inside the tarball
 *   - the packed pure modules still export their public API
 *   - the packed factory registers its whole surface (flags, /tps, renderer, lifecycle)
 *   - a simulated run paints a meter line into the footer and prints the feed summary
 *
 * The run is simulated by driving the real event handlers with the payload shapes
 * captured from a live session, so this catches a broken factory without needing
 * a model call or credentials, which is what makes it safe to run in CI.
 */
import {execFileSync} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const REQUIRED_FILES = [
	'package.json',
	'README.md',
	'LICENSE',
	'index.ts',
	'src/metrics.ts',
	'src/status.ts',
	'src/controller.ts',
	'src/events.ts',
	'types/commandcode-harness.d.ts',
]

function fail(message) {
	console.error(`smoke: ${message}`)
	process.exit(1)
}

const temp = mkdtempSync(join(tmpdir(), 'commandcode-token-metrics-smoke-'))

try {
	const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', temp], {cwd: process.cwd(), encoding: 'utf8'})
	const [info] = JSON.parse(raw)
	const files = info.files.map((entry) => entry.path)

	const missing = REQUIRED_FILES.filter((file) => !files.includes(file))
	if (missing.length > 0) fail(`tarball is missing: ${missing.join(', ')}`)

	execFileSync('tar', ['xzf', join(temp, info.filename), '-C', temp])
	const extracted = join(temp, 'package')
	const pkg = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))

	const mods = pkg.commandcode?.mods
	if (!Array.isArray(mods) || mods.length === 0) fail('package.json "commandcode.mods" must list at least one mod file')
	for (const entry of mods) {
		if (typeof entry !== 'string' || !entry.startsWith('./')) fail(`mod entry "${entry}" must be a relative ./ path`)
		if (!existsSync(join(extracted, entry))) fail(`mod entry "${entry}" does not resolve in the tarball`)
	}

	const metrics = await import(join(extracted, 'src', 'metrics.ts'))
	for (const name of ['TpsMeter', 'MeterStore', 'formatLine', 'measureRate', 'rateTier']) {
		if (metrics[name] === undefined) fail(`src/metrics.ts is missing ${name}`)
	}

	const status = await import(join(extracted, 'src', 'status.ts'))
	for (const name of ['formatStatus', 'formatSummary', 'ANSI']) {
		if (status[name] === undefined) fail(`src/status.ts is missing ${name}`)
	}

	// ── drive the real factory against a fake host ──────────────────────────────
	const mod = await import(join(extracted, mods[0]))
	if (typeof mod.default !== 'function') fail('the mod file must default-export a factory')

	const registered = {flags: [], events: [], commands: [], renderers: []}
	const statuses = []
	const entries = []
	const flagDefaults = new Map()
	const handlers = new Map()
	const disposable = {dispose() {}}

	const cmd = {
		name: 'smoke',
		cwd: extracted,
		session: undefined,
		ui: {
			notify() {},
			setStatus(text) {
				statuses.push(text)
				return disposable
			},
			capabilities: {status: true},
		},
		on(event, handler) {
			registered.events.push(event)
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
			return disposable
		},
		hooks() {
			return disposable
		},
		addFlag(name, spec) {
			registered.flags.push(name)
			flagDefaults.set(name, spec.default)
			return disposable
		},
		getFlag(name) {
			return flagDefaults.get(name)
		},
		addCommand(command) {
			registered.commands.push(command)
			return disposable
		},
		addRenderer(customType) {
			registered.renderers.push(customType)
			return disposable
		},
		showEntry(customType, data) {
			entries.push({customType, data})
		},
	}

	mod.default(cmd)

	if (registered.flags.length === 0) fail('the factory registered no flags')
	if (!registered.events.includes('session_start') || !registered.events.includes('session_shutdown')) {
		fail('the factory did not subscribe to the session lifecycle')
	}
	if (!registered.renderers.includes('tps-summary')) fail('the factory registered no tps-summary renderer')

	const tps = registered.commands.find((command) => command.name === 'tps')
	if (!tps) fail('the factory registered no /tps command')

	const emit = (event, payload = {}) => {
		for (const handler of [...(handlers.get(event) ?? [])]) handler(payload)
	}

	emit('session_start', {type: 'session_start'})
	emit('run_start', {type: 'run_start', sessionId: 'smoke-session'})
	emit('model_request_start', {type: 'model_request_start', model: 'smoke/model'})
	emit('text_delta', {type: 'text_delta', delta: 'a'.repeat(400)})
	emit('model_request_end', {type: 'model_request_end', model: 'smoke/model', usage: {outputTokens: 150}})
	emit('run_end', {type: 'run_end'})

	// The feed summary is emitted straight from the settle callback.
	if (entries.length === 0) fail('no feed summary entry was shown when the run ended')
	const entry = entries[entries.length - 1]
	if (entry.customType !== 'tps-summary') fail(`unexpected feed entry type: ${entry.customType}`)
	const summary = entry.data?.line ?? ''
	if (!summary.includes('150 tok')) fail(`the feed summary did not report the exact total: ${summary}`)
	if (!summary.includes('smoke/model')) fail(`the feed summary did not report the model: ${summary}`)

	// The footer repaint is throttled, so give the coalescing timer a moment.
	await new Promise((resolve) => setTimeout(resolve, 250))

	const painted = statuses.filter((line) => typeof line === 'string' && line.includes('tok/s'))
	if (painted.length === 0) fail('no meter line was painted into the footer during the simulated run')

	const report = tps.handler({args: [], cwd: extracted})
	if (!report?.message?.includes('150 tok')) fail(`/tps did not report the last run: ${report?.message}`)

	emit('session_shutdown', {type: 'session_shutdown'})
	if (statuses[statuses.length - 1] !== null) fail('session shutdown must clear the footer segment')

	console.log(
		`smoke: OK (${files.length} files, ${info.filename}, ${painted.length} painted frames, ${registered.flags.length} flags)`,
	)
} finally {
	rmSync(temp, {recursive: true, force: true})
}
