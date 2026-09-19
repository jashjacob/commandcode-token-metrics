/**
 * Ambient types for the host-provided `@commandcode/harness` module.
 *
 * A mod is compiled and loaded by Command Code's own runtime (jiti), which
 * supplies `@commandcode/harness` at load time; it is never `npm install`ed
 * into a mod's own tree. This file exists so `npm run typecheck` works on a
 * clean checkout with no extra dependency, and so the mod can be authored
 * without network access.
 *
 * It declares only the surface this mod actually touches. If Command Code ever
 * publishes the harness types as a package, delete this file and depend on it
 * instead.
 */
declare module '@commandcode/harness' {
	/** Handle returned by every registration; `.dispose()` undoes it. */
	export type Disposable = {
		dispose(): void
	}

	/** The footer status segment surface (`cmd.ui`), narrowed to what we use. */
	export type ModUi = {
		notify(message: string, level?: 'info' | 'warning' | 'error'): void
		/** Replaces this mod's footer segment; `null` clears it. */
		setStatus(text: string | null): Disposable
		readonly capabilities: {
			/** Whether this host renders footer segments (false in headless runs). */
			readonly status: boolean
		}
	}

	/** Options for a mod-declared flag, read with `cmd.getFlag` / `--mod-option`. */
	export type ModFlagOptions = {
		type: 'boolean' | 'string'
		default?: boolean | string
		description?: string
	}

	/** Context handed to a slash-command handler. */
	export type ModCommandContext = {
		args: string[]
		cwd: string
	}

	/** What a slash-command handler may return. */
	export type ModCommandResult = {
		/** Submits an automated model turn. */
		prompt?: string
		/** Renders an info row in the feed. */
		message?: string
	}

	export type ModCommand = {
		name: string
		description?: string
		argumentHint?: string
		handler: (ctx: ModCommandContext) => ModCommandResult | void | Promise<ModCommandResult | void>
	}

	/** The mutating lifecycle. Only the hooks this mod uses are declared. */
	export type ModHooks = {
		onRunEnd?(input: {state: unknown; result: unknown}): void | Promise<void>
		onTurnEnd?(input: {state: unknown; turnNumber: number; hadToolCalls: boolean; usage: unknown}): unknown
		onSessionStart?(input: {source: 'startup' | 'resume'}): void | Promise<void>
		onSessionEnd?(input: {reason: 'shutdown' | 'replaced'}): void | Promise<void>
	}

	/**
	 * The mod API, bound as `cmd` in a mod factory.
	 *
	 * Event payloads are deliberately `unknown`: they are snapshots produced by
	 * another system, so this mod validates the fields it reads at runtime
	 * (see `src/events.ts`) rather than promising a shape it cannot enforce.
	 */
	export interface ModApi {
		readonly name: string
		readonly cwd: string
		readonly ui: ModUi
		readonly session: unknown
		on(event: string, handler: (payload: unknown) => void): Disposable
		hooks(hooks: ModHooks): Disposable
		addFlag(name: string, options: ModFlagOptions): Disposable
		getFlag(name: string): boolean | string | undefined
		addCommand(command: ModCommand): Disposable
		addRenderer(customType: string, render: (data: unknown) => readonly string[]): Disposable
		showEntry(customType: string, data?: unknown): void
	}
}
