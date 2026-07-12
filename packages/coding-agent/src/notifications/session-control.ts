import { isSessionNotificationsEnabled, isTelegramConfigured, type NotificationConfig } from "./config";

/** Minimal session-manager surface shared by extension, TUI, and headless hosts. */
export interface NotificationSessionContext {
	sessionManager: {
		getCwd(): string;
		getSessionId(): string;
	};
}

/** A snapshot of the current session, resolved from the session manager per operation. */
export interface BoundNotificationSession<Context extends NotificationSessionContext = NotificationSessionContext> {
	readonly context: Context;
	readonly cwd: string;
	readonly sessionId: string;
	unbind(): void;
}

export type NotificationEndpointStartResult = "started" | "already" | "disabled" | "failed";

/**
 * The endpoint implementation is deliberately injected. The controller owns
 * policy and session-local state while the extension continues to own its
 * concrete NotificationServer resources.
 */
export interface NotificationSessionRuntime<Context extends NotificationSessionContext = NotificationSessionContext> {
	isRunning(binding: BoundNotificationSession<Context>): boolean;
	start(binding: BoundNotificationSession<Context>): Promise<NotificationEndpointStartResult>;
	stop(binding: BoundNotificationSession<Context>): Promise<boolean>;
	ensureTelegramDaemon?(binding: BoundNotificationSession<Context>): Promise<void>;
}

export interface NotificationSessionStatus {
	eligible: boolean;
	locallyEnabled: boolean;
	effectiveEnabled: boolean;
	running: boolean;
	environment: "off" | "explicit" | "token" | "default";
}

export interface NotificationSessionReconcileResult {
	outcome: NotificationEndpointStartResult | "stopped";
	status: NotificationSessionStatus;
}

export interface NotificationSessionControllerOptions {
	/** Gate A result, resolved once by the SDK from the canonical host predicate. */
	eligible: boolean;
	/** Reads the global-only, schema-default-resolved notification configuration. */
	getConfig(): NotificationConfig;
	/** Kept as a reference so test and embedding hosts can supply their own environment. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Shared owner of notification session policy.
 *
 * Gate A is captured at creation. Gate B is evaluated for each session
 * operation with `isSessionNotificationsEnabled`. Gate C is delegated only
 * after a running generic endpoint and only for complete Telegram config.
 */
export class NotificationSessionController {
	readonly #eligible: boolean;
	readonly #getConfig: () => NotificationConfig;
	readonly #env: NodeJS.ProcessEnv;
	readonly #disabledSessions = new Set<string>();
	/** Sessions held inactive after a post-commit foreign daemon identity race. */
	readonly #blockedRuntimeSessions = new Set<string>();
	#runtime: NotificationSessionRuntime<any> | undefined;

	constructor(options: NotificationSessionControllerOptions) {
		this.#eligible = options.eligible;
		this.#getConfig = options.getConfig;
		this.#env = options.env ?? process.env;
	}

	/** Attach the concrete generic endpoint implementation used by this host. */
	attachRuntime<Context extends NotificationSessionContext>(runtime: NotificationSessionRuntime<Context>): () => void {
		this.#runtime = runtime as NotificationSessionRuntime<any>;
		return () => {
			if (this.#runtime === runtime) this.#runtime = undefined;
		};
	}

	/**
	 * Bind a fresh session snapshot. Callers should not cache it: cwd and session
	 * id may change on `/new`, fork, or resume.
	 */
	bind<Context extends NotificationSessionContext>(context: Context): BoundNotificationSession<Context> {
		let bound = true;
		return {
			cwd: context.sessionManager.getCwd(),
			sessionId: context.sessionManager.getSessionId(),
			unbind: () => {
				bound = false;
			},
			get context() {
				if (!bound) throw new Error("Notification session binding has been released.");
				return context;
			},
		};
	}

	/** Preserve session-local safety state when `/new` or fork rekeys a live session. */
	rekeySession(previousSessionId: string, nextSessionId: string): void {
		if (previousSessionId === nextSessionId) return;
		if (this.#disabledSessions.delete(previousSessionId)) this.#disabledSessions.add(nextSessionId);
		if (this.#blockedRuntimeSessions.delete(previousSessionId)) this.#blockedRuntimeSessions.add(nextSessionId);
	}

	query<Context extends NotificationSessionContext>(context: Context): NotificationSessionStatus {
		const binding = this.bind(context);
		try {
			return this.#query(binding);
		} finally {
			binding.unbind();
		}
	}

	/** Stop the current endpoint during host shutdown without changing local preference. */
	async stopCurrentSession<Context extends NotificationSessionContext>(context: Context): Promise<boolean> {
		const binding = this.bind(context);
		try {
			const runtime = this.#runtime as NotificationSessionRuntime<Context> | undefined;
			return runtime?.isRunning(binding) ? await runtime.stop(binding) : false;
		} finally {
			binding.unbind();
		}
	}

	/**
	 * Hold this session's endpoint inactive after a foreign-daemon identity race.
	 * The block remains until an explicit same-identity reconnect or CAS restore clears it.
	 */
	async enterBlockedRuntime<Context extends NotificationSessionContext>(context: Context): Promise<boolean> {
		const binding = this.bind(context);
		try {
			this.#blockedRuntimeSessions.add(binding.sessionId);
			const runtime = this.#runtime as NotificationSessionRuntime<Context> | undefined;
			return runtime?.isRunning(binding) ? await runtime.stop(binding) : false;
		} finally {
			binding.unbind();
		}
	}

	/** Clear a block only after the caller has verified a safe same-identity reconnect or restore. */
	async clearBlockedRuntime<Context extends NotificationSessionContext>(context: Context): Promise<void> {
		const binding = this.bind(context);
		try {
			this.#blockedRuntimeSessions.delete(binding.sessionId);
		} finally {
			binding.unbind();
		}
	}

	async setLocalEnabled<Context extends NotificationSessionContext>(
		context: Context,
		enabled: boolean,
	): Promise<NotificationSessionReconcileResult> {
		const binding = this.bind(context);
		try {
			if (enabled) this.#disabledSessions.delete(binding.sessionId);
			else this.#disabledSessions.add(binding.sessionId);
		} finally {
			binding.unbind();
		}
		return await this.reconcileCurrentSession(context);
	}

	async reconcileCurrentSession<Context extends NotificationSessionContext>(
		context: Context,
	): Promise<NotificationSessionReconcileResult> {
		const binding = this.bind(context);
		try {
			const cfg = this.#getConfig();
			const runtime = this.#runtime as NotificationSessionRuntime<Context> | undefined;
			const status = this.#status(binding, cfg, runtime);
			if (!status.effectiveEnabled) {
				if (runtime && status.running) await runtime.stop(binding);
				return { outcome: status.running ? "stopped" : "disabled", status: this.#status(binding, cfg, runtime) };
			}

			if (!runtime) return { outcome: "disabled", status };
			const outcome = status.running ? "already" : await runtime.start(binding);
			const current = this.#status(binding, cfg, runtime);
			if (!current.effectiveEnabled) {
				if (current.running) await runtime.stop(binding);
				return { outcome: current.running ? "stopped" : "disabled", status: this.#status(binding, cfg, runtime) };
			}
			if ((outcome === "started" || outcome === "already") && current.running && isTelegramConfigured(cfg)) {
				await runtime.ensureTelegramDaemon?.(binding);
			}
			return { outcome, status: this.#status(binding, cfg, runtime) };
		} finally {
			binding.unbind();
		}
	}

	#query(binding: BoundNotificationSession<any>): NotificationSessionStatus {
		const cfg = this.#getConfig();
		return this.#status(binding, cfg, this.#runtime);
	}

	#status(
		binding: BoundNotificationSession<any>,
		cfg: NotificationConfig,
		runtime: NotificationSessionRuntime<any> | undefined,
	): NotificationSessionStatus {
		const locallyEnabled = !this.#disabledSessions.has(binding.sessionId);
		const blockedRuntime = this.#blockedRuntimeSessions.has(binding.sessionId);
		const effectiveEnabled =
			!blockedRuntime &&
			this.#eligible &&
			isSessionNotificationsEnabled({ cfg, env: this.#env, sessionDisabled: !locallyEnabled });
		const environment =
			this.#env.GJC_NOTIFICATIONS === "0"
				? "off"
				: this.#env.GJC_NOTIFICATIONS === "1"
					? "explicit"
					: this.#env.GJC_NOTIFICATIONS_TOKEN
						? "token"
						: "default";
		return {
			eligible: this.#eligible,
			locallyEnabled,
			effectiveEnabled,
			running: runtime?.isRunning(binding) ?? false,
			environment,
		};
	}
}
