/**
 * Translates Command Code's event stream into calls on the `MeterStore`. Kept
 * free of any rendering, and typed against a narrow structural slice of the mod
 * API, so it can be exercised with a fake event bus in tests.
 *
 * One run (a user turn) is one meter turn. A run spans several model requests
 * (one per round), which all feed the same graph, average and exact token total;
 * a tool call closes the streaming burst so the pause does not count as
 * generation time.
 *
 * Session lifecycle is deliberately NOT handled here: a `TpsMeter` is built on
 * demand per session id, and the caller decides when a session is replaced (it
 * needs to rebuild the meter anyway, because flag values are only readable once
 * the harness has bound; see `index.ts`).
 */
import {readDelta, readModel, readOutputTokens, readSessionId} from './events'
import {MeterStore, type RateConfig, type Snapshot} from './metrics'

/** The slice of the mod API the meter needs. Structural, so tests can fake it. */
export type MeterApi = {
	on(event: string, handler: (payload: unknown) => void): {dispose(): void}
}

/** Why a run's frame was frozen. */
export type SettleReason = 'ended' | 'interrupted'

export type MeterHandlers = {
	/** Something changed that the caller may want to repaint. */
	onChange: () => void
	/** The run closed and its frame is now frozen, ready to be reported. */
	onSettled?: (reason: SettleReason) => void
}

export type MeterController = {
	/** The active session's meter view, or undefined when no run has started. */
	snapshot: (at?: number, columns?: number) => Snapshot | undefined
	/** Model that handled the most recent request, when the host reported one. */
	model: () => string | undefined
	/** Drop samples outside the rolling window. */
	tick: (now?: number) => void
	dispose: () => void
}

export function createMeterController(
	api: MeterApi,
	config: RateConfig,
	handlers: MeterHandlers,
	clock: () => number = Date.now,
): MeterController {
	const store = new MeterStore(config, clock)
	const disposers: Array<() => void> = []
	let session: string | undefined
	let currentModel: string | undefined
	let runSeq = 0

	const record = (payload: unknown) => {
		if (!session) return
		if (!store.record(session, readDelta(payload), clock())) return
		handlers.onChange()
	}

	const settle = (reason: SettleReason) => {
		if (!session) return
		store.settle(session, clock())
		handlers.onSettled?.(reason)
		handlers.onChange()
	}

	const subscribe = (event: string, handler: (payload: unknown) => void) => {
		disposers.push(api.on(event, handler).dispose)
	}

	subscribe('run_start', (payload) => {
		session = readSessionId(payload) ?? session ?? 'default'
		runSeq += 1
		store.beginTurn(session, `${session}#${runSeq}`, clock())
		handlers.onChange()
	})

	// Fires before each round's inference call. The first one in a run is the
	// anchor for ttft, so the figure measures provider latency rather than the
	// host's own work between the prompt and the request.
	subscribe('model_request_start', (payload) => {
		currentModel = readModel(payload) ?? currentModel
		if (session) store.setTtftAnchor(session, clock())
	})

	subscribe('text_delta', record)
	subscribe('thinking_delta', record)

	// A tool call ends the current burst: the live rate restarts afterwards and
	// the pause is excluded from the average, while the graph stays continuous.
	subscribe('tool_running', () => {
		if (session) store.newSegment(session)
	})

	subscribe('model_request_end', (payload) => {
		currentModel = readModel(payload) ?? currentModel
		if (session) store.addExact(session, readOutputTokens(payload))
	})

	subscribe('run_end', () => settle('ended'))

	// An interrupted run never emits run_end, so freeze what was measured instead
	// of leaving the meter live forever.
	subscribe('interrupted', () => settle('interrupted'))

	return {
		snapshot: (at = clock(), columns = 12) => (session ? store.snapshot(session, at, columns) : undefined),
		model: () => currentModel,
		tick: (now = clock()) => store.prune(now),
		dispose: () => {
			for (const off of disposers.splice(0)) off()
		},
	}
}
