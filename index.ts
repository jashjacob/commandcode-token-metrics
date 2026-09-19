/**
 * A live tokens-per-second meter for Command Code.
 *
 * The host repaints a mod's footer status segment on every `setStatus` call, and
 * prints its text verbatim (only newlines, tabs and runs of spaces are
 * collapsed), so ansi escapes survive, which makes a single line under the
 * input panel a good home for a VU-style throughput graph.
 *
 * Rendered line:
 *
 *     tok/s ▃▆▇▇█▆▄ 42.0 ▲15% · avg 38.2 · pk 45.0 · ttft 0.8s
 *
 * All measurement lives in `src/metrics.ts` (pure), the ansi line in
 * `src/status.ts` (pure), and the event wiring in `src/controller.ts`.
 *
 * One wrinkle worth knowing: `cmd.getFlag` only returns real values once the
 * harness has bound, so configuration is resolved on `session_start` rather than
 * while the factory runs. Reading flags earlier silently yields the declared
 * defaults, which would disable every option without any error.
 */
import type {ModApi, ModFlagOptions} from '@commandcode/harness'
import {appendFileSync} from 'node:fs'
import {createMeterController, type MeterController} from './src/controller'
import {hasData, type RateConfig, type Snapshot, type VuScale} from './src/metrics'
import {formatStatus, formatSummary, type StatusOptions, type SummaryOptions} from './src/status'

/** Minimum gap between repaints. The host dedupes identical text, so this only bounds string building. */
const PAINT_MIN_MS = 100
/** Advances the VU graph one column per second and ages idle samples out. */
const TICK_MS = 1000
/** Custom feed entry type for the end-of-run summary row. */
const SUMMARY_TYPE = 'tps-summary'

/** Every option is a `--mod-option name=value` flag; numbers arrive as strings. */
const FLAGS = {
	enabled: {type: 'boolean', default: true, description: 'Render the meter at all.'},
	rollingWindowMs: {type: 'string', default: '5000', description: 'Averaging window for the live rate.'},
	idleTimeoutMs: {type: 'string', default: '1500', description: 'Silence after which the rate reads as inactive.'},
	minSpanMs: {type: 'string', default: '300', description: 'Floor on the elapsed span so early samples do not spike.'},
	vuColumns: {type: 'string', default: '12', description: 'Maximum seconds of history shown in the VU meter.'},
	vuScale: {type: 'string', default: 'auto', description: 'auto scales columns to the run peak; fixed uses vuFullTps.'},
	vuFullTps: {type: 'string', default: '50', description: 'Full-scale tokens/sec when vuScale is fixed.'},
	slowTps: {type: 'string', default: '10', description: 'Below this is "slow" (red).'},
	fastTps: {type: 'string', default: '30', description: 'At or above this is "fast" (green).'},
	showVu: {type: 'boolean', default: true, description: 'Show the VU meter.'},
	showTrend: {type: 'boolean', default: true, description: 'Show the trend arrow.'},
	showAvg: {type: 'boolean', default: true, description: 'Show the run average.'},
	showPeak: {type: 'boolean', default: true, description: 'Show the peak.'},
	showTtft: {type: 'boolean', default: true, description: 'Show time to first token.'},
	showTokenCount: {type: 'boolean', default: false, description: 'Show the token counter.'},
	showElapsed: {type: 'boolean', default: false, description: 'Show elapsed run time.'},
	alwaysShow: {type: 'boolean', default: false, description: 'Keep the meter visible when idle instead of hiding it.'},
	idleText: {type: 'string', default: 'idle', description: 'Placeholder shown with alwaysShow when there is no data.'},
	label: {type: 'string', default: 'tok/s', description: 'Leading label.'},
	feedSummary: {type: 'boolean', default: true, description: 'Print a one-line summary into the feed when a run ends.'},
	statusLog: {type: 'string', default: '', description: 'Debug: append every painted status line to this file.'},
} satisfies Record<string, ModFlagOptions>

type ResolvedOptions = StatusOptions & {
	enabled: boolean
	rollingWindowMs: number
	idleTimeoutMs: number
	minSpanMs: number
	feedSummary: boolean
	statusLog: string
}

/** Flag values are strings (or booleans); coerce and fall back rather than throw. */
function resolveOptions(cmd: ModApi): ResolvedOptions {
	const raw = (name: string) => cmd.getFlag(name)
	const number = (name: string, fallback: number): number => {
		const value = Number(raw(name))
		return Number.isFinite(value) && value > 0 ? value : fallback
	}
	const bool = (name: string, fallback: boolean): boolean => {
		const value = raw(name)
		if (typeof value === 'boolean') return value
		if (value === 'true') return true
		if (value === 'false') return false
		return fallback
	}
	const text = (name: string, fallback: string): string => {
		const value = raw(name)
		return typeof value === 'string' && value.length > 0 ? value : fallback
	}
	const vuScale: VuScale = text('vuScale', 'auto') === 'fixed' ? 'fixed' : 'auto'

	return {
		enabled: bool('enabled', true),
		rollingWindowMs: number('rollingWindowMs', 5000),
		idleTimeoutMs: number('idleTimeoutMs', 1500),
		minSpanMs: number('minSpanMs', 300),
		vuColumns: number('vuColumns', 12),
		vuScale,
		vuFullTps: number('vuFullTps', 50),
		slowTps: number('slowTps', 10),
		fastTps: number('fastTps', 30),
		showVu: bool('showVu', true),
		showTrend: bool('showTrend', true),
		showAvg: bool('showAvg', true),
		showPeak: bool('showPeak', true),
		showTtft: bool('showTtft', true),
		showTokenCount: bool('showTokenCount', false),
		showElapsed: bool('showElapsed', false),
		alwaysShow: bool('alwaysShow', false),
		idleText: text('idleText', 'idle'),
		label: text('label', 'tok/s'),
		feedSummary: bool('feedSummary', true),
		statusLog: text('statusLog', ''),
	}
}

export default function (cmd: ModApi): void {
	for (const [name, spec] of Object.entries(FLAGS)) cmd.addFlag(name, spec)

	cmd.addRenderer(SUMMARY_TYPE, renderSummaryEntry)

	let active: Active | undefined

	const summaryOptions = (options: ResolvedOptions, model?: string): SummaryOptions => ({
		showVu: options.showVu,
		vuColumns: options.vuColumns,
		vuScale: options.vuScale,
		vuFullTps: options.vuFullTps,
		slowTps: options.slowTps,
		fastTps: options.fastTps,
		model,
	})

	const paint = (force = false) => {
		const current = active
		if (!current) return
		const now = Date.now()
		const since = now - current.lastPaint
		// Coalesce bursts of deltas into at most one repaint per PAINT_MIN_MS.
		if (!force && since < PAINT_MIN_MS) {
			if (current.pending === undefined) {
				current.pending = setTimeout(() => {
					if (active !== current) return
					current.pending = undefined
					paint(true)
				}, PAINT_MIN_MS - since)
			}
			return
		}
		current.lastPaint = now
		const snapshot = current.controller.snapshot(now, current.options.vuColumns)
		const line = formatStatus(snapshot, current.options)
		if (current.options.statusLog) logStatus(current.options.statusLog, line, snapshot)
		if (cmd.ui.capabilities.status) cmd.ui.setStatus(line ?? null)
	}

	const showSummary = () => {
		const current = active
		if (!current || !current.options.feedSummary) return
		const snapshot = current.controller.snapshot(Date.now(), current.options.vuColumns)
		if (!snapshot || !hasData(snapshot)) return
		cmd.showEntry(SUMMARY_TYPE, {line: formatSummary(snapshot, summaryOptions(current.options, current.controller.model()))})
	}

	const deactivate = () => {
		const current = active
		if (!current) return
		active = undefined
		current.controller.dispose()
		clearInterval(current.timer)
		if (current.pending !== undefined) clearTimeout(current.pending)
		if (cmd.ui.capabilities.status) cmd.ui.setStatus(null)
	}

	// Rebuilt per session: flag values are only readable once the harness has
	// bound, and `session_start` always precedes the first run.
	const activate = () => {
		deactivate()
		const options = resolveOptions(cmd)
		if (!options.enabled) return
		const controller = createMeterController(cmd, meterConfig(options), {
			onChange: () => paint(),
			onSettled: (reason) => {
				if (reason === 'ended') showSummary()
				// Force the frozen frame out immediately rather than letting the
				// throttle defer it: a run can end just before the host tears down.
				paint(true)
			},
		})
		const timer = setInterval(() => {
			const current = active
			if (!current) return
			current.controller.tick()
			paint(true)
		}, TICK_MS)
		active = {options, controller, timer, lastPaint: 0, pending: undefined}
		paint(true)
	}

	cmd.addCommand({
		name: 'tps',
		description: "Show the last run's token throughput",
		handler: () => {
			const current = active
			if (!current) return {message: `${FLAGS.label.default}: the meter is not active in this session.`}
			const snapshot = current.controller.snapshot(Date.now(), current.options.vuColumns)
			if (!snapshot || !hasData(snapshot)) {
				return {message: `${current.options.label}: nothing measured yet; send a prompt first.`}
			}
			return {message: formatSummary(snapshot, summaryOptions(current.options, current.controller.model()))}
		},
	})

	cmd.on('session_start', activate)
	cmd.on('session_shutdown', deactivate)
}

type Active = {
	options: ResolvedOptions
	controller: MeterController
	timer: ReturnType<typeof setInterval>
	lastPaint: number
	pending: ReturnType<typeof setTimeout> | undefined
}

function meterConfig(options: ResolvedOptions): RateConfig {
	return {
		rollingWindowMs: options.rollingWindowMs,
		idleTimeoutMs: options.idleTimeoutMs,
		minSpanMs: options.minSpanMs,
	}
}

/** A renderer must never throw; the host degrades a throw to a warning notice. */
function renderSummaryEntry(data: unknown): readonly string[] {
	const line = typeof data === 'object' && data !== null ? (data as {line?: unknown}).line : undefined
	if (typeof line === 'string') return [line]
	return [JSON.stringify(data)]
}

/** Strip ansi so the debug log stays readable. */
function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** Debug aid used by the smoke test to observe a real run headlessly. */
function logStatus(file: string, line: string | undefined, snapshot: Snapshot | undefined): void {
	try {
		appendFileSync(
			file,
			`${JSON.stringify({
				at: Date.now(),
				line: line === undefined ? null : stripAnsi(line),
				rate: snapshot?.rate ?? null,
				avg: snapshot?.avg ?? null,
				peak: snapshot?.peak ?? null,
				ttftMs: snapshot?.ttftMs ?? null,
				tokens: snapshot?.tokens ?? null,
				exact: snapshot?.exact ?? null,
				settled: snapshot?.settled ?? null,
				vu: snapshot?.vu ?? null,
			})}\n`,
		)
	} catch {
		// Logging must never break the session.
	}
}
