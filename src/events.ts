/**
 * Readers for the event payloads this mod consumes.
 *
 * Event payloads cross a system boundary: they are snapshots produced by the
 * host, and the mod API types them as `unknown` on purpose. Every field is
 * therefore read defensively here, in one place, so the controller can work with
 * plain values and tests can feed it half-populated payloads.
 *
 * Payload shapes below were captured from a live run (`cmd -p ... --mod`).
 */

/** Token accounting as the provider reports it. */
export type TokenUsage = {
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** `run_start` carries the session id that the rest of the run's events share. */
export function readSessionId(payload: unknown): string | undefined {
	const value = asRecord(payload)?.sessionId
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `text_delta` / `thinking_delta` carry the streamed chunk. */
export function readDelta(payload: unknown): string {
	const value = asRecord(payload)?.delta
	return typeof value === 'string' ? value : ''
}

/** `model_request_start` / `model_request_end` name the model handling the call. */
export function readModel(payload: unknown): string | undefined {
	const value = asRecord(payload)?.model
	return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * `model_request_end.usage.outputTokens`: the provider's exact count of tokens
 * generated for that request, which is what the estimate is reconciled against.
 */
export function readOutputTokens(payload: unknown): number {
	const usage = asRecord(asRecord(payload)?.usage)
	const value = usage?.outputTokens
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
