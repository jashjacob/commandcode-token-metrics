/**
 * Renders a snapshot as a single styled footer line. Pure string building with no
 * mod-API imports, so the exact bytes painted into the footer are unit testable.
 *
 * Command Code prints a mod's status segment verbatim and only collapses
 * newlines, tabs and runs of spaces, so ansi escapes survive and a one-line
 * meter is a natural fit.
 */
import {
	formatClock,
	formatCount,
	formatLine,
	formatRate,
	hasData,
	rateTier,
	renderVu,
	vuFullScale,
	type DisplayOptions,
	type Snapshot,
	type Tier,
	type VuScale,
} from './metrics'

/** Ansi escapes, kept deliberately basic so every terminal theme can render them. */
export type Palette = {
	slow: string
	medium: string
	fast: string
	muted: string
	reset: string
}

/** Red below `slowTps`, yellow below `fastTps`, green at or above it. */
export const ANSI: Palette = {
	slow: '\x1b[31m',
	medium: '\x1b[33m',
	fast: '\x1b[32m',
	muted: '\x1b[2m',
	reset: '\x1b[0m',
}

/** Color for a speed band; idle reads as muted rather than an error. */
export function tierColor(tier: Tier, palette: Palette = ANSI): string {
	switch (tier) {
		case 'slow':
			return palette.slow
		case 'medium':
			return palette.medium
		case 'fast':
			return palette.fast
		default:
			return palette.muted
	}
}

/** The meter's tunables plus what the line should include. */
export type StatusOptions = DisplayOptions & {
	slowTps: number
	fastTps: number
	alwaysShow: boolean
	idleText: string
}

/**
 * The line to paint, or `undefined` when the meter should occupy no space at all
 * (nothing measured yet and `alwaysShow` is off).
 */
export function formatStatus(snapshot: Snapshot | undefined, options: StatusOptions, palette: Palette = ANSI): string | undefined {
	if (!hasData(snapshot) || !snapshot) {
		return options.alwaysShow ? `${palette.muted}${options.label} ${options.idleText}${palette.reset}` : undefined
	}
	const color = tierColor(rateTier(snapshot.rate, options.slowTps, options.fastTps), palette)
	return `${color}${formatLine(snapshot, options)}${palette.reset}`
}

/** What the feed summary row needs, on top of the meter's display options. */
export type SummaryOptions = {
	showVu: boolean
	vuColumns: number
	vuScale: VuScale
	vuFullTps: number
	slowTps: number
	fastTps: number
	/** Model that produced the run, when the host reported one. */
	model?: string
}

/**
 * A permanent one-line summary of a finished run for the feed: the frozen frame,
 * the exact token total and the model. The footer already holds the live frame,
 * so this is the scrollback record.
 */
export function formatSummary(snapshot: Snapshot, options: SummaryOptions, palette: Palette = ANSI): string {
	const parts: string[] = []
	if (options.showVu) {
		const scale = vuFullScale(snapshot.vu, options.vuScale, options.vuFullTps, snapshot.peakBucket)
		const graph = renderVu(snapshot.vu, options.vuColumns, scale)
		if (graph) parts.push(graph)
	}
	parts.push(`${formatRate(snapshot.rate)} tok/s`)
	parts.push(`avg ${formatRate(snapshot.avg)}`)
	parts.push(`pk ${formatRate(snapshot.peak)}`)
	if (snapshot.ttftMs !== undefined) parts.push(`ttft ${formatClock(snapshot.ttftMs)}`)
	parts.push(`${formatCount(snapshot.tokens)} tok${snapshot.exact ? '' : ' (est)'}`)
	parts.push(formatClock(snapshot.elapsed))
	if (options.model) parts.push(options.model)

	const color = tierColor(rateTier(snapshot.rate, options.slowTps, options.fastTps), palette)
	return `◆ ${color}${parts.join(' · ')}${palette.reset}`
}
