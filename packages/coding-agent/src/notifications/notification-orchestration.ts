import type { CasReceipt, CasRestoreResult } from "../config/atomic-yaml-patch";
import type { SettingsAtomicPatch } from "../config/settings";
import {
	getNotificationConfig,
	hasNonBlankValue,
	type NotificationSettingsReader,
	type NotificationSettingsSnapshot,
	tokenFingerprint,
} from "./config";
import {
	DAEMON_VERSION,
	type EnsureTelegramDaemonDetailedResult,
	readDaemonState,
	type TelegramDaemonFs,
} from "./telegram-daemon";

/** The identity relationship between a proposed Telegram configuration and a live daemon owner. */
export type ProposedTelegramIdentityStatus = "absent" | "same" | "foreign" | "unknown";

/**
 * Non-secret metadata about a daemon owner. Token fingerprints and the owner's
 * chat ID intentionally never cross this boundary. `chatDisplay`, when present,
 * is supplied by the caller from an already-approved proposed-chat display.
 */
export interface TelegramDaemonOwnerMetadata {
	ownerId: string;
	pid: number;
	generation?: number;
	chatDisplay?: string;
}

/** Secret-safe proposed-identity preflight outcome. */
export interface ProposedTelegramIdentity {
	status: ProposedTelegramIdentityStatus;
	owner?: TelegramDaemonOwnerMetadata;
}

export interface ProposedTelegramIdentityPreflightInput {
	settings: NotificationSettingsReader;
	botToken: string;
	chatId: string;
	/** A UI-approved display value for the proposed chat; never inferred from a foreign daemon state. */
	chatDisplay?: string;
	deps?: {
		fs?: TelegramDaemonFs;
		pidAlive?: (pid: number) => boolean;
	};
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validGeneration(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

/**
 * Compare a proposed identity with the current daemon owner without exposing a
 * token or token fingerprint. Invalid/unreadable state is deliberately
 * `unknown`, which callers must treat as cancel-by-default.
 */
export async function proposedTelegramIdentity(
	input: ProposedTelegramIdentityPreflightInput,
): Promise<ProposedTelegramIdentity> {
	if (!hasNonBlankValue(input.botToken) || !hasNonBlankValue(input.chatId)) return { status: "unknown" };

	try {
		const state = await readDaemonState(input.settings, input.deps?.fs);
		if (!state) return { status: "absent" };

		const metadata =
			typeof state.ownerId === "string" &&
			state.ownerId.trim().length > 0 &&
			validPositiveInteger(state.pid) &&
			validGeneration(state.generation)
				? {
						ownerId: state.ownerId,
						pid: state.pid,
						...(state.generation === undefined ? {} : { generation: state.generation }),
					}
				: undefined;
		if (
			!metadata ||
			state.version !== DAEMON_VERSION ||
			typeof state.tokenFingerprint !== "string" ||
			typeof state.chatId !== "string"
		) {
			return metadata ? { status: "unknown", owner: metadata } : { status: "unknown" };
		}

		const pidAlive = input.deps?.pidAlive ?? defaultPidAlive;
		if (!pidAlive(metadata.pid)) return { status: "absent" };

		if (state.tokenFingerprint === tokenFingerprint(input.botToken) && state.chatId === input.chatId) {
			return {
				status: "same",
				owner: input.chatDisplay === undefined ? metadata : { ...metadata, chatDisplay: input.chatDisplay },
			};
		}
		return { status: "foreign", owner: metadata };
	} catch {
		return { status: "unknown" };
	}
}

export interface NotificationConfigurationWriter extends NotificationSettingsReader {
	commitAtomicBatch(patches: readonly SettingsAtomicPatch[]): Promise<CasReceipt>;
}

export type CompleteNonTelegramAdapter = "discord" | "slack";

export type SaveTelegramInactiveAvailability =
	| { available: true }
	| {
			available: false;
			completeAdapters: readonly CompleteNonTelegramAdapter[];
			guidance: string;
	  };

function completeNonTelegramAdapters(snapshot: NotificationSettingsSnapshot): CompleteNonTelegramAdapter[] {
	if (!snapshot.enabled) return [];
	const adapters: CompleteNonTelegramAdapter[] = [];
	if (hasNonBlankValue(snapshot.discord.botToken) && hasNonBlankValue(snapshot.discord.channelId)) {
		adapters.push("discord");
	}
	if (hasNonBlankValue(snapshot.slack.botToken) && hasNonBlankValue(snapshot.slack.channelId)) {
		adapters.push("slack");
	}
	return adapters;
}

/**
 * Saving Telegram inactive writes `notifications.enabled=false`; it is unsafe
 * while another complete adapter is globally active because that would disable
 * Discord or Slack too.
 */
export function getSaveTelegramInactiveAvailability(
	settings: NotificationSettingsReader,
): SaveTelegramInactiveAvailability {
	const completeAdapters = completeNonTelegramAdapters(settings.getNotificationSettingsSnapshot());
	if (completeAdapters.length === 0) return { available: true };
	return {
		available: false,
		completeAdapters,
		guidance:
			"Save inactive is unavailable because globally disabling notifications would also disable the configured Discord or Slack adapter. Cancel or retry after the foreign daemon exits or is reconfigured.",
	};
}

export type SaveTelegramInactiveResult =
	| { status: "saved_inactive"; receipt: CasReceipt }
	| {
			status: "unavailable";
			completeAdapters: readonly CompleteNonTelegramAdapter[];
			guidance: string;
	  };

/** Atomically persist Telegram credentials with global notifications disabled when it is safe to do so. */
export async function saveTelegramInactive(input: {
	settings: NotificationConfigurationWriter;
	botToken: string;
	chatId: string;
}): Promise<SaveTelegramInactiveResult> {
	if (!hasNonBlankValue(input.botToken) || !hasNonBlankValue(input.chatId)) {
		throw new TypeError("Saving inactive Telegram configuration requires a non-blank token and chat ID.");
	}
	const availability = getSaveTelegramInactiveAvailability(input.settings);
	if (!availability.available) {
		return {
			status: "unavailable",
			completeAdapters: availability.completeAdapters,
			guidance: availability.guidance,
		};
	}
	const receipt = await input.settings.commitAtomicBatch([
		{ path: "notifications.telegram.botToken", op: "set", value: input.botToken },
		{ path: "notifications.telegram.chatId", op: "set", value: input.chatId },
		{ path: "notifications.enabled", op: "set", value: false },
	]);
	return { status: "saved_inactive", receipt };
}

/**
 * Remove Telegram credentials without disturbing other adapters. Global
 * notifications become disabled only when Telegram was the last complete adapter.
 */
export async function removeTelegramConfiguration(input: {
	settings: NotificationConfigurationWriter;
}): Promise<{ receipt: CasReceipt; globallyDisabled: boolean }> {
	const cfg = getNotificationConfig(input.settings);
	const otherAdapterRemains =
		(hasNonBlankValue(cfg.discord.botToken) && hasNonBlankValue(cfg.discord.channelId)) ||
		(hasNonBlankValue(cfg.slack.botToken) && hasNonBlankValue(cfg.slack.channelId));
	const patches: SettingsAtomicPatch[] = [
		{ path: "notifications.telegram.botToken", op: "unset" },
		{ path: "notifications.telegram.chatId", op: "unset" },
	];
	if (!otherAdapterRemains) patches.push({ path: "notifications.enabled", op: "set", value: false });
	const receipt = await input.settings.commitAtomicBatch(patches);
	return { receipt, globallyDisabled: !otherAdapterRemains };
}

/** Detailed outcome of checking or reconnecting the Telegram daemon after a durable commit. */
export type TelegramDaemonReconnectOutcome = EnsureTelegramDaemonDetailedResult;

/**
 * The session controller must not resolve `enterBlockedRuntime` until its
 * current endpoint has stopped and been removed. This lets callers report a
 * blocked save only after no further frames can reach the foreign owner.
 */
export interface NotificationRuntimeController {
	/** Resolves only after the current endpoint is stopped and removed. */
	enterBlockedRuntime(): Promise<unknown>;
	clearBlockedRuntime(): Promise<unknown>;
	reconcileCurrentSession(): Promise<unknown>;
}

export interface TelegramPostCommitActivation {
	controller: NotificationRuntimeController;
	reconnect: () => Promise<TelegramDaemonReconnectOutcome>;
}

export type PostCommitTelegramActivationResult =
	| { status: "activated"; reconnect: Exclude<TelegramDaemonReconnectOutcome, "blocked_identity"> }
	| {
			status: "blocked_identity";
			message: string;
			restore(): Promise<BlockedTelegramRestoreResult>;
			retainCommitted(): void;
	  };

export type BlockedTelegramRestoreResult =
	| { status: "restored"; reconnect: TelegramDaemonReconnectOutcome }
	| { status: "conflict"; paths: readonly string[] }
	| { status: "discarded" }
	| { status: "still_blocked" };

async function restoreBlockedConfiguration(input: {
	receipt: CasReceipt;
	activation: TelegramPostCommitActivation;
}): Promise<BlockedTelegramRestoreResult> {
	const restored: CasRestoreResult = await input.receipt.restore();
	if (restored.status === "conflict") return restored;
	if (restored.status === "discarded") return restored;

	const reconnect = await input.activation.reconnect();
	if (reconnect === "blocked_identity") {
		await input.activation.controller.enterBlockedRuntime();
		return { status: "still_blocked" };
	}
	await input.activation.controller.clearBlockedRuntime();
	await input.activation.controller.reconcileCurrentSession();
	return { status: "restored", reconnect };
}

/**
 * Complete a committed Telegram update in the required order: identity
 * reconnect first, normal session reconciliation second. A post-commit foreign
 * owner race blocks and stops the current endpoint before completion is exposed.
 */
export async function reconcileCommittedTelegramConfiguration(input: {
	receipt: CasReceipt;
	activation: TelegramPostCommitActivation;
}): Promise<PostCommitTelegramActivationResult> {
	const reconnect = await input.activation.reconnect();
	if (reconnect === "blocked_identity") {
		await input.activation.controller.enterBlockedRuntime();
		return {
			status: "blocked_identity",
			message:
				"Configuration saved; activation blocked; foreign daemon untouched. Current session stopped because Telegram activation was blocked by a foreign daemon.",
			restore: () => restoreBlockedConfiguration(input),
			retainCommitted: () => input.receipt.discard(),
		};
	}

	if (reconnect === "spawned" || reconnect === "reloaded" || reconnect === "attached") {
		await input.activation.controller.clearBlockedRuntime();
	}
	await input.activation.controller.reconcileCurrentSession();
	return { status: "activated", reconnect };
}

export type SaveTelegramConfigurationResult =
	| { status: "cancelled"; preflight: ProposedTelegramIdentity; guidance: string }
	| SaveTelegramInactiveResult
	| { status: "saved"; receipt: CasReceipt; preflight: ProposedTelegramIdentity }
	| PostCommitTelegramActivationResult;

/**
 * Guard a Telegram setup commit with proposed-identity preflight. Foreign and
 * unreadable ownership are cancel-by-default and make no configuration changes.
 */
export async function saveTelegramConfiguration(input: {
	settings: NotificationConfigurationWriter;
	botToken: string;
	chatId: string;
	chatDisplay?: string;
	/** Explicitly persist credentials disabled after a foreign/unknown preflight; otherwise cancel remains the default. */
	saveInactive: boolean;
	preflight?: (input: Omit<ProposedTelegramIdentityPreflightInput, "settings">) => Promise<ProposedTelegramIdentity>;
	activation?: TelegramPostCommitActivation;
}): Promise<SaveTelegramConfigurationResult> {
	if (!hasNonBlankValue(input.botToken) || !hasNonBlankValue(input.chatId)) {
		throw new TypeError("Saving Telegram configuration requires a non-blank token and chat ID.");
	}
	const runPreflight =
		input.preflight ??
		((next: Omit<ProposedTelegramIdentityPreflightInput, "settings">) =>
			proposedTelegramIdentity({ settings: input.settings, ...next }));
	const preflight = await runPreflight({
		botToken: input.botToken,
		chatId: input.chatId,
		chatDisplay: input.chatDisplay,
	});
	if (preflight.status === "foreign" || preflight.status === "unknown") {
		// Cancel is the default for an untrusted owner. `saveInactive` is an
		// explicit user selection that cannot activate the proposed identity.
		if (input.saveInactive) return await saveTelegramInactive(input);
		return {
			status: "cancelled",
			preflight,
			guidance:
				"Telegram activation was not saved. Cancel or retry after the daemon owner exits or is reconfigured.",
		};
	}

	if (input.saveInactive) return await saveTelegramInactive(input);

	const receipt = await input.settings.commitAtomicBatch([
		{ path: "notifications.telegram.botToken", op: "set", value: input.botToken },
		{ path: "notifications.telegram.chatId", op: "set", value: input.chatId },
		{ path: "notifications.enabled", op: "set", value: true },
	]);
	if (!input.activation) return { status: "saved", receipt, preflight };
	return await reconcileCommittedTelegramConfiguration({ receipt, activation: input.activation });
}
