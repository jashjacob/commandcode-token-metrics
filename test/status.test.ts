import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import type {Snapshot} from '../src/metrics'
import {ANSI, formatStatus, formatSummary, tierColor, type StatusOptions, type SummaryOptions} from '../src/status'

/** A settled-looking frame with data in every segment. */
const base: Snapshot = {
	rate: 42.5,
	avg: 38.2,
	live: true,
	settled: false,
	tokens: 1200,
	exact: true,
	elapsed: 12_000,
	peak: 61,
	peakBucket: 55,
	trend: 'up',
	trendPct: 18,
	ttftMs: 800,
	vu: [10, 20, 30, 40],
}

const options: StatusOptions = {
	label: 'tok/s',
	showVu: true,
	vuColumns: 12,
	vuScale: 'auto',
	vuFullTps: 50,
	showTrend: true,
	showAvg: true,
	showPeak: true,
	showTtft: true,
	showTokenCount: false,
	showElapsed: false,
	slowTps: 10,
	fastTps: 30,
	alwaysShow: false,
	idleText: 'idle',
}

const summaryOptions: SummaryOptions = {
	showVu: true,
	vuColumns: 12,
	vuScale: 'auto',
	vuFullTps: 50,
	slowTps: 10,
	fastTps: 30,
	model: 'test/model',
}

describe('tierColor', () => {
	it('maps each band onto the palette', () => {
		assert.equal(tierColor('slow'), ANSI.slow)
		assert.equal(tierColor('medium'), ANSI.medium)
		assert.equal(tierColor('fast'), ANSI.fast)
		assert.equal(tierColor('idle'), ANSI.muted)
	})
})

describe('formatStatus', () => {
	it('renders nothing when there is no data and alwaysShow is off', () => {
		assert.equal(formatStatus(undefined, options), undefined)
		assert.equal(formatStatus({...base, tokens: 0, peak: 0}, options), undefined)
	})

	it('renders the idle placeholder when alwaysShow is on', () => {
		assert.equal(formatStatus(undefined, {...options, alwaysShow: true}), `${ANSI.muted}tok/s idle${ANSI.reset}`)
	})

	it('wraps the line in the tier color', () => {
		assert.equal(
			formatStatus(base, options),
			`${ANSI.fast}tok/s ▁▃▄▆ 42.5 ▲18% · avg 38.2 · pk 61.0 · ttft 0.8s${ANSI.reset}`,
		)
	})

	it('colors a slow rate red', () => {
		const line = formatStatus({...base, rate: 5}, options)
		assert.ok(line?.startsWith(ANSI.slow))
	})

	it('colors a medium rate yellow', () => {
		const line = formatStatus({...base, rate: 20}, options)
		assert.ok(line?.startsWith(ANSI.medium))
	})

	it('colors an inactive rate muted, even with a held frame', () => {
		const line = formatStatus({...base, rate: -1, trend: 'none'}, options)
		assert.ok(line?.startsWith(ANSI.muted))
		assert.ok(line?.includes('tok/s ▁▃▄▆ - · avg 38.2'))
	})

	it('honours the display toggles', () => {
		const line = formatStatus(base, {...options, showVu: false, showTrend: false, label: 'tps'})
		assert.equal(line, `${ANSI.fast}tps 42.5 · avg 38.2 · pk 61.0 · ttft 0.8s${ANSI.reset}`)
	})
})

describe('formatSummary', () => {
	it('renders the full run summary with the model', () => {
		assert.equal(
			formatSummary(base, summaryOptions),
			`◆ ${ANSI.fast}▁▃▄▆ · 42.5 tok/s · avg 38.2 · pk 61.0 · ttft 0.8s · 1.2k tok · 12.0s · test/model${ANSI.reset}`,
		)
	})

	it('marks an estimate when the provider never reported exact usage', () => {
		const line = formatSummary({...base, exact: false}, summaryOptions)
		assert.ok(line.includes('1.2k tok (est)'))
	})

	it('omits the model when the host did not report one', () => {
		const line = formatSummary(base, {...summaryOptions, model: undefined})
		assert.ok(line.endsWith(`12.0s${ANSI.reset}`))
	})

	it('omits the graph when showVu is off', () => {
		const line = formatSummary(base, {...summaryOptions, showVu: false})
		assert.ok(line.includes('42.5 tok/s · avg 38.2'))
		assert.ok(!line.includes('▁'))
	})

	it('omits ttft when it is unknown', () => {
		const line = formatSummary({...base, ttftMs: undefined}, summaryOptions)
		assert.ok(!line.includes('ttft'))
	})
})
