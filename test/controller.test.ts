import assert from 'node:assert/strict'
import {describe, it} from 'node:test'
import {createMeterController, type MeterApi, type SettleReason} from '../src/controller'

const CONFIG = {rollingWindowMs: 5000, idleTimeoutMs: 1500, minSpanMs: 300}

type Handler = (payload: unknown) => void

/** A fake event bus plus a controllable clock. */
function harness() {
	const handlers = new Map<string, Handler[]>()
	let now = 0

	const api: MeterApi = {
		on(event, handler) {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
			return {
				dispose() {
					const current = handlers.get(event)
					if (!current) return
					const index = current.indexOf(handler)
					if (index >= 0) current.splice(index, 1)
				},
			}
		},
	}

	return {
		api,
		clock: () => now,
		setNow: (value: number) => {
			now = value
		},
		emit: (event: string, payload: unknown = {}) => {
			for (const handler of [...(handlers.get(event) ?? [])]) handler(payload)
		},
		handlerCount: () => [...handlers.values()].reduce((total, list) => total + list.length, 0),
	}
}

describe('createMeterController', () => {
	it('measures nothing before a run starts', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('text_delta', {delta: 'abcdefgh'})
		assert.equal(controller.snapshot(0, 4), undefined)
		assert.equal(controller.model(), undefined)
	})

	it('records streamed text for the active run', () => {
		const h = harness()
		let updates = 0
		const controller = createMeterController(h.api, CONFIG, {onChange: () => (updates += 1)}, h.clock)

		h.emit('run_start', {sessionId: 's1'})
		h.emit('model_request_start', {model: 'test/model'})
		h.setNow(500)
		h.emit('text_delta', {delta: 'abcdefgh'})

		assert.equal(controller.snapshot(500, 4)?.tokens, 2)
		assert.equal(controller.model(), 'test/model')
		assert.ok(updates >= 2)
	})

	it('counts reasoning deltas too', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.emit('thinking_delta', {delta: 'abcdefgh'})
		assert.equal(controller.snapshot(0, 4)?.tokens, 2)
	})

	it('ignores payloads without a usable delta', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.emit('text_delta', {delta: 42})
		h.emit('text_delta', {})
		h.emit('text_delta', undefined)
		assert.equal(controller.snapshot(0, 4)?.tokens, 0)
	})

	it('starts a new segment when a tool runs, keeping the totals', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.emit('text_delta', {delta: 'abcdefgh'})
		h.setNow(1200)
		h.emit('tool_running', {toolName: 'shell_command'})
		const snapshot = controller.snapshot(1200, 4)
		assert.equal(snapshot?.tokens, 2)
		assert.equal(snapshot?.rate, -1)
	})

	it('uses exact usage and freezes the frame when the run ends', () => {
		const h = harness()
		const settled: SettleReason[] = []
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}, onSettled: (reason) => settled.push(reason)}, h.clock)

		h.emit('run_start', {sessionId: 's1'})
		h.setNow(1000)
		h.emit('text_delta', {delta: 'a'.repeat(40)})
		h.emit('model_request_end', {model: 'test/model', usage: {outputTokens: 65}})
		h.setNow(1100)
		h.emit('run_end', {result: {turnCount: 1}})

		const snapshot = controller.snapshot(1100, 4)
		assert.equal(snapshot?.settled, true)
		assert.equal(snapshot?.tokens, 65)
		assert.equal(snapshot?.exact, true)
		assert.deepEqual(settled, ['ended'])
	})

	it('sums exact usage across the run\u2019s model requests', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.emit('text_delta', {delta: 'a'.repeat(40)})
		h.emit('model_request_end', {usage: {outputTokens: 65}})
		h.emit('tool_running', {})
		h.emit('text_delta', {delta: 'a'.repeat(40)})
		h.emit('model_request_end', {usage: {outputTokens: 15}})
		h.emit('run_end', {})
		assert.equal(controller.snapshot(0, 4)?.tokens, 80)
	})

	it('ignores a missing or nonsense usage payload', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.emit('text_delta', {delta: 'a'.repeat(40)})
		h.emit('model_request_end', {})
		h.emit('model_request_end', {usage: {outputTokens: 'lots'}})
		h.emit('run_end', {})
		const snapshot = controller.snapshot(0, 4)
		assert.equal(snapshot?.exact, false)
		assert.equal(snapshot?.tokens, 10)
	})

	it('freezes on interrupt, which never emits run_end', () => {
		const h = harness()
		const settled: SettleReason[] = []
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}, onSettled: (reason) => settled.push(reason)}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.emit('text_delta', {delta: 'abcdefgh'})
		h.emit('interrupted')
		assert.equal(controller.snapshot(0, 4)?.settled, true)
		assert.deepEqual(settled, ['interrupted'])
	})

	it('measures ttft from the first inference request of the run', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.setNow(1000)
		h.emit('run_start', {sessionId: 's1'})
		h.setNow(1400)
		h.emit('model_request_start', {model: 'test/model'})
		h.setNow(1900)
		h.emit('text_delta', {delta: 'abcdefgh'})
		assert.equal(controller.snapshot(1900, 4)?.ttftMs, 500)
	})

	it('resets measurement when a new run starts in the same session', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.setNow(1000)
		h.emit('text_delta', {delta: 'a'.repeat(40)})
		assert.equal(controller.snapshot(1000, 4)?.tokens, 10)

		h.setNow(5000)
		h.emit('run_start', {sessionId: 's1'})
		h.setNow(5100)
		h.emit('text_delta', {delta: 'a'.repeat(40)})
		const snapshot = controller.snapshot(5100, 4)
		assert.equal(snapshot?.tokens, 10)
		assert.equal(snapshot?.settled, false)
	})

	it('follows the newest session when runs interleave', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.emit('text_delta', {delta: 'a'.repeat(40)})
		h.emit('run_start', {sessionId: 's2'})
		h.emit('text_delta', {delta: 'a'.repeat(80)})
		assert.equal(controller.snapshot(0, 4)?.tokens, 20)
	})

	it('tick prunes without dropping the frozen frame', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		h.emit('run_start', {sessionId: 's1'})
		h.setNow(1000)
		h.emit('text_delta', {delta: 'a'.repeat(40)})
		h.emit('model_request_end', {usage: {outputTokens: 10}})
		h.emit('run_end', {})
		h.setNow(500_000)
		controller.tick()
		assert.equal(controller.snapshot(500_000, 4)?.tokens, 10)
	})

	it('dispose unregisters every handler', () => {
		const h = harness()
		const controller = createMeterController(h.api, CONFIG, {onChange: () => {}}, h.clock)
		assert.ok(h.handlerCount() > 0)
		controller.dispose()
		assert.equal(h.handlerCount(), 0)
	})
})
