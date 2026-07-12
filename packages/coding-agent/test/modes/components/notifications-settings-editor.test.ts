import { beforeAll, describe, expect, it } from "bun:test";
import {
	type NotificationsEditorOperations,
	type NotificationsEditorPreferences,
	type NotificationsEditorSetupInput,
	type NotificationsEditorState,
	type NotificationsPreflightResult,
	NotificationsSettingsEditorComponent,
} from "@gajae-code/coding-agent/modes/components/notifications-settings-editor";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { NotificationHealthReport } from "@gajae-code/coding-agent/notifications/notification-service";

beforeAll(async () => {
	await initTheme();
});

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function health(overall: "ok" | "warn" | "error" = "warn"): NotificationHealthReport {
	return {
		overall,
		configured: true,
		checks: [{ name: "daemon", level: overall, detail: overall === "warn" ? "heartbeat is stale" : "healthy" }],
		daemon: {
			present: true,
			ownerId: "daemon-local",
			pid: 321,
			alive: true,
			heartbeatFresh: overall === "ok",
			identityMatches: true,
			stopped: false,
			heartbeatAt: 1_700_000_000_000,
			heartbeatAgeMs: 42_000,
			generation: 4,
			currentGeneration: 4,
			generationRelation: "current",
		},
		endpoints: { total: 3, live: 2, dead: 0, unknown: 1, unreadable: 0 },
		reachability: { probed: false, ok: false, detail: "not probed" },
	};
}

function state(): NotificationsEditorState {
	return {
		status: {
			enabled: true,
			redact: false,
			verbosity: "lean",
			globallyConfigured: true,
			telegram: {
				botTokenMasked: "••••••••",
				channel: "1001",
				configured: true,
				tokenFingerprint: "telegram:deadbeef",
			},
			discord: { botTokenMasked: "••••", channel: "discord-channel", configured: true },
			slack: { botTokenMasked: "••••", channel: "slack-channel", configured: true },
		},
		session: { eligible: true, locallyEnabled: true, effectiveEnabled: true, running: true, environment: "default" },
		preferences: {
			redact: false,
			verbosity: "lean",
			sessionScope: "all",
			richEnabled: true,
			richDraftEnabled: false,
		},
		health: health(),
	};
}

class FakeNotificationsOperations implements NotificationsEditorOperations {
	readonly state = state();
	readonly committedPreferences: NotificationsEditorPreferences[] = [];
	preflightGate: Deferred<NotificationsPreflightResult> | undefined;
	healthGate: Deferred<NotificationHealthReport> | undefined;
	recoverFailure = false;
	testGate: Deferred<{ ok: boolean; adapter: "telegram"; chatId: string | undefined; detail: string }> | undefined;
	preflightSignal: AbortSignal | undefined;
	healthSignal: AbortSignal | undefined;
	removedTelegram = false;

	async loadState(): Promise<NotificationsEditorState> {
		return this.state;
	}

	async refreshHealth(input: { probe: boolean; signal?: AbortSignal }): Promise<NotificationHealthReport> {
		this.healthSignal = input.signal;
		if (this.healthGate) return await this.healthGate.promise;
		const next = health(input.probe ? "ok" : "warn");
		next.reachability = input.probe ? { probed: true, ok: true, detail: "reachable" } : next.reachability;
		this.state.health = next;
		return next;
	}

	async sendTest() {
		if (this.testGate) return await this.testGate.promise;
		return { ok: true, adapter: "telegram" as const, chatId: "1001", detail: "delivered to chat 1001" };
	}

	async recover() {
		if (this.recoverFailure) throw new Error("recover failed");
		return {
			endpointsScanned: 3,
			endpointsRemoved: [],
			endpointsKept: 3,
			endpointsUnreadable: 0,
			daemon: { action: "none" as const, detail: "no dead owner", ownerId: "daemon-local", pid: 321 },
		};
	}

	async reconnect() {
		return "attached" as const;
	}
	async preflightProposedIdentity(
		input: NotificationsEditorSetupInput,
		signal: AbortSignal,
	): Promise<NotificationsPreflightResult> {
		this.preflightSignal = signal;
		void input.token.consume();
		if (this.preflightGate) return await this.preflightGate.promise;
		return {
			status: "ready",
			identity: { status: "absent" },
			message: "Telegram destination is ready.",
			draft: {
				chatId: input.chatId,
				tokenMask: "••••••••",
				tokenFingerprint: "telegram:cafefeed",
				richEnabled: input.richEnabled,
				richDraftEnabled: input.richDraftEnabled,
			},
		};
	}

	async commitConfigure() {
		return { status: "saved" as const, receipt: {} as never, message: "Telegram configuration saved." };
	}

	async saveInactive() {
		return {
			status: "unavailable" as const,
			guidance: "Discord and Slack remain enabled; inactive save is unavailable.",
		};
	}

	discardConfigureDraft(): void {
		// The fake holds no credential material; real adapters clear their opaque draft here.
	}

	async enableGlobally() {
		this.state.status.enabled = true;
		return { message: "Enabled with stored credentials." };
	}

	async disableGlobally() {
		this.state.status.enabled = false;
		return { message: "Disabled globally." };
	}

	async removeTelegram() {
		this.removedTelegram = true;
		this.state.status.telegram = {
			botTokenMasked: "(not set)",
			channel: undefined,
			configured: false,
			tokenFingerprint: undefined,
		};
		return { message: "Telegram removed; Discord and Slack remain enabled.", globallyDisabled: false };
	}

	async setSessionLocal(enabled: boolean) {
		this.state.session = {
			...this.state.session,
			locallyEnabled: enabled,
			effectiveEnabled: enabled,
			running: enabled,
		};
		return { outcome: enabled ? ("started" as const) : ("stopped" as const), status: this.state.session };
	}

	async commitPreferences(preferences: NotificationsEditorPreferences) {
		this.committedPreferences.push({ ...preferences });
		this.state.preferences = { ...preferences };
		this.state.status.redact = preferences.redact;
		this.state.status.verbosity = preferences.verbosity;
		return { message: "Preferences saved." };
	}

	async reconcileCurrentSession() {
		return { outcome: "already" as const, status: this.state.session };
	}
}

function render(component: NotificationsSettingsEditorComponent, width = 120): string {
	return Bun.stripANSI(component.render(width).join("\n"));
}

function select(component: NotificationsSettingsEditorComponent, index: number): void {
	for (let count = 0; count < index; count += 1) component.handleInput("\x1b[B");
}

function enterTelegramToken(component: NotificationsSettingsEditorComponent, token: string): void {
	component.handleInput("\n");
	component.handleInput("1001");
	component.handleInput("\n");
	component.handleInput(token);
}

describe("NotificationsSettingsEditorComponent", () => {
	it("uses masked secret entry and keeps all drafts out of settings until an explicit commit", async () => {
		const operations = new FakeNotificationsOperations();
		const component = new NotificationsSettingsEditorComponent(operations);
		const rawToken = "123456:abcdefghijklmnopqrstuvwxyz_ABCDE";
		await flush();

		enterTelegramToken(component, rawToken);
		expect(render(component, 80)).toContain("masked bot token");
		expect(render(component, 80)).not.toContain(rawToken);

		component.handleInput("\n");
		await flush();
		const review = render(component);
		expect(review).toContain("Review Telegram notification setup");
		expect(review).toContain("••••••••");
		expect(review).toContain("telegram:cafefeed");
		expect(review).not.toContain(rawToken);

		component.handleInput("\x1b");
		expect(component.mode).toBe("home");
		expect(operations.committedPreferences).toEqual([]);

		select(component, 10);
		component.handleInput("\n");
		expect(render(component)).toContain("unsaved draft");
		component.handleInput("\n"); // redact on in the editor-only preference draft
		expect(operations.committedPreferences).toEqual([]);
		select(component, 5);
		component.handleInput("\n");
		await flush();
		expect(operations.committedPreferences).toEqual([
			{ redact: true, verbosity: "lean", sessionScope: "all", richEnabled: true, richDraftEnabled: false },
		]);
	});

	it("honors Escape for local cancellation, confirmation cancellation, and the parent cancel callback", async () => {
		const operations = new FakeNotificationsOperations();
		let parentCancels = 0;
		const component = new NotificationsSettingsEditorComponent(operations, { onCancel: () => (parentCancels += 1) });
		await flush();

		select(component, 2);
		component.handleInput("\n");
		expect(render(component)).toContain("Disable notifications globally?");
		expect(render(component)).toContain("Cancel");
		component.handleInput("\x1b");
		expect(operations.state.status.enabled).toBe(true);
		expect(component.mode).toBe("home");

		component.handleInput("\x1b");
		expect(parentCancels).toBe(1);
	});

	it("preserves non-Telegram adapters during adapter-local removal and renders textual health labels", async () => {
		const operations = new FakeNotificationsOperations();
		const component = new NotificationsSettingsEditorComponent(operations);
		await flush();

		const initial = render(component, 160);
		expect(initial).toContain("Health: WARNING");
		expect(initial).toContain("heartbeat:");
		expect(initial).toContain("generation 4/4 (current)");
		expect(initial).toContain("Endpoints: 3 total");

		select(component, 9);
		component.handleInput("\n");
		component.handleInput("\x1b[A"); // Cancel is the safe default; choose explicit Confirm.
		component.handleInput("\n");
		await flush();
		expect(operations.removedTelegram).toBe(true);
		expect(operations.state.status.telegram.configured).toBe(false);
		expect(operations.state.status.discord.configured).toBe(true);
		expect(operations.state.status.slack.configured).toBe(true);
		expect(render(component)).toContain("Telegram removed; Discord and Slack remain enabled.");
	});

	it("locks non-cancellable delivery, aborts cancellable work, and ignores late results after disposal", async () => {
		const operations = new FakeNotificationsOperations();
		operations.testGate = deferred();
		const component = new NotificationsSettingsEditorComponent(operations);
		await flush();

		select(component, 6);
		component.handleInput("\n");
		expect(component.navigationLocked).toBe(true);
		expect(render(component)).toContain("PENDING");
		component.handleInput("\x1b");
		expect(render(component)).toContain("Navigation is locked");
		operations.testGate.resolve({ ok: true, adapter: "telegram", chatId: "1001", detail: "delivered" });
		await flush();
		expect(component.navigationLocked).toBe(false);
		expect(render(component, 160)).toContain("Last in-editor test: OK");

		operations.recoverFailure = true;
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		await flush();
		expect(render(component)).toContain("ERROR — Notification action failed safely.");

		const pairingOperations = new FakeNotificationsOperations();
		pairingOperations.preflightGate = deferred();
		const pairing = new NotificationsSettingsEditorComponent(pairingOperations);
		await flush();
		enterTelegramToken(pairing, "123456:abcdefghijklmnopqrstuvwxyz_ABCDE");
		pairing.handleInput("\n");
		expect(pairing.mode).toBe("pairing");
		pairing.handleInput("\x1b");
		expect(pairingOperations.preflightSignal?.aborted).toBe(true);
		pairingOperations.preflightGate.resolve({
			status: "ready",
			identity: { status: "foreign" },
			message: "late foreign result",
			draft: { chatId: "1001", tokenMask: "••••", richEnabled: true, richDraftEnabled: false },
		});
		await flush();
		expect(pairing.mode).toBe("home");
		expect(render(pairing)).not.toContain("late foreign result");

		const probeOperations = new FakeNotificationsOperations();
		probeOperations.healthGate = deferred();
		const probe = new NotificationsSettingsEditorComponent(probeOperations);
		await flush();
		select(probe, 5);
		probe.handleInput("\n");
		const disposing = probe.requestDispose();
		expect(probeOperations.healthSignal?.aborted).toBe(true);
		probeOperations.healthGate.resolve({
			...health("ok"),
			checks: [{ name: "reachability", level: "ok", detail: "late health result" }],
		});
		expect(await disposing).toBe(true);
		expect(render(probe)).not.toContain("late health result");
	});
});
