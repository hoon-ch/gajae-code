import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CasReceipt, CasRestoreResult } from "../src/config/atomic-yaml-patch";
import type { SettingsAtomicPatch } from "../src/config/settings";
import type { NotificationSettingsSnapshot } from "../src/notifications/config";
import { tokenFingerprint } from "../src/notifications/config";
import {
	getSaveTelegramInactiveAvailability,
	type NotificationConfigurationWriter,
	proposedTelegramIdentity,
	removeTelegramConfiguration,
	saveTelegramConfiguration,
	saveTelegramInactive,
} from "../src/notifications/notification-orchestration";
import { DAEMON_GENERATION, DAEMON_VERSION, daemonPaths } from "../src/notifications/telegram-daemon";

const TOKEN = "1234567890:ABCDEFghijkLmnOpQrsTuvWxYz012345678";
const FOREIGN_TOKEN = "9876543210:ZYXWVutsrqponmlkjihgfedcba987654321";
const agentDirs: string[] = [];

afterEach(() => {
	for (const dir of agentDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-notification-orchestration-test-"));
	agentDirs.push(dir);
	return dir;
}

function snapshot(overrides: Partial<NotificationSettingsSnapshot> = {}): NotificationSettingsSnapshot {
	return {
		enabled: true,
		telegram: {
			botToken: "stored-telegram-token",
			chatId: "stored-chat",
			rich: { enabled: true },
			richDraft: { enabled: false },
			topics: {},
		},
		discord: {},
		slack: {},
		redact: false,
		verbosity: "lean",
		sessionScope: "all",
		idleTimeoutMs: 60_000,
		...overrides,
	};
}

function receipt(onDiscard?: () => void): CasReceipt {
	const result: CasReceipt = {
		revisions: [],
		restore: async (): Promise<CasRestoreResult> => ({ status: "restored", receipt: result }),
		discard: () => onDiscard?.(),
	};
	return result;
}

function writer(input: { snapshot?: NotificationSettingsSnapshot; agentDir?: string } = {}): {
	writer: NotificationConfigurationWriter;
	commits: SettingsAtomicPatch[][];
} {
	const initial = input.snapshot ?? snapshot();
	const commits: SettingsAtomicPatch[][] = [];
	return {
		writer: {
			getAgentDir: () => input.agentDir ?? "/tmp/gjc-notification-orchestration",
			getNotificationSettingsSnapshot: () => structuredClone(initial),
			commitAtomicBatch: async patches => {
				commits.push(structuredClone(patches) as SettingsAtomicPatch[]);
				return receipt();
			},
		},
		commits,
	};
}

function writeLiveForeignOwner(agentDir: string): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(
		paths.state,
		JSON.stringify({
			pid: 44_444,
			ownerId: "foreign-owner",
			tokenFingerprint: tokenFingerprint(FOREIGN_TOKEN),
			chatId: "foreign-chat",
			startedAt: 1,
			heartbeatAt: 1,
			roots: [],
			version: DAEMON_VERSION,
			generation: DAEMON_GENERATION,
		}),
	);
}

describe("notification orchestration proposed identity", () => {
	test("foreign preflight cancels before commit without serializing a token", async () => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir);
		const { writer: settings, commits } = writer({ agentDir });

		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: next => proposedTelegramIdentity({ settings, ...next, deps: { pidAlive: pid => pid === 44_444 } }),
		});

		expect(result.status).toBe("cancelled");
		expect(commits).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
		expect(JSON.stringify(result)).not.toContain(FOREIGN_TOKEN);
		if (result.status === "cancelled") {
			expect(result.preflight).toEqual({
				status: "foreign",
				owner: { ownerId: "foreign-owner", pid: 44_444, generation: DAEMON_GENERATION },
			});
		}
	});

	test("same preflight includes only caller-approved chat display", async () => {
		const agentDir = tempAgentDir();
		const paths = daemonPaths(agentDir);
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				pid: 222,
				ownerId: "same-owner",
				tokenFingerprint: tokenFingerprint(TOKEN),
				chatId: "private-chat",
				startedAt: 1,
				heartbeatAt: 1,
				roots: [],
				version: DAEMON_VERSION,
				generation: DAEMON_GENERATION,
			}),
		);
		const { writer: settings } = writer({ agentDir });

		const result = await proposedTelegramIdentity({
			settings,
			botToken: TOKEN,
			chatId: "private-chat",
			chatDisplay: "Approved private chat",
			deps: { pidAlive: pid => pid === 222 },
		});

		expect(result).toEqual({
			status: "same",
			owner: {
				ownerId: "same-owner",
				pid: 222,
				generation: DAEMON_GENERATION,
				chatDisplay: "Approved private chat",
			},
		});
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});
});

describe("notification orchestration save inactive", () => {
	test("Telegram plus Discord makes Save inactive unavailable without changing any fields", async () => {
		const configured = snapshot({
			discord: { botToken: "discord-token", channelId: "discord-channel" },
		});
		const before = JSON.stringify(configured);
		const { writer: settings, commits } = writer({ snapshot: configured });

		const availability = getSaveTelegramInactiveAvailability(settings);
		const result = await saveTelegramInactive({ settings, botToken: TOKEN, chatId: "new-chat" });

		expect(availability).toMatchObject({ available: false, completeAdapters: ["discord"] });
		expect(result).toMatchObject({ status: "unavailable", completeAdapters: ["discord"] });
		expect(commits).toEqual([]);
		expect(JSON.stringify(configured)).toBe(before);
	});

	test("Telegram plus Slack makes Save inactive unavailable without changing any fields", async () => {
		const configured = snapshot({
			slack: { botToken: "slack-token", channelId: "slack-channel" },
		});
		const before = JSON.stringify(configured);
		const { writer: settings, commits } = writer({ snapshot: configured });

		const result = await saveTelegramInactive({ settings, botToken: TOKEN, chatId: "new-chat" });

		expect(result).toMatchObject({ status: "unavailable", completeAdapters: ["slack"] });
		expect(commits).toEqual([]);
		expect(JSON.stringify(configured)).toBe(before);
	});

	test("a Telegram-only foreign owner can explicitly save inactive without activation", async () => {
		const agentDir = tempAgentDir();
		writeLiveForeignOwner(agentDir);
		const { writer: settings, commits } = writer({ agentDir });

		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: true,
			preflight: next => proposedTelegramIdentity({ settings, ...next, deps: { pidAlive: pid => pid === 44_444 } }),
		});

		expect(result.status).toBe("saved_inactive");
		expect(commits).toEqual([
			[
				{ path: "notifications.telegram.botToken", op: "set", value: TOKEN },
				{ path: "notifications.telegram.chatId", op: "set", value: "new-chat" },
				{ path: "notifications.enabled", op: "set", value: false },
			],
		]);
	});
	test("Remove Telegram preserves global enable with another complete adapter and disables it only when Telegram is last", async () => {
		const { writer: withDiscord, commits: discordCommits } = writer({
			snapshot: snapshot({ discord: { botToken: "discord-token", channelId: "discord-channel" } }),
		});
		const discordResult = await removeTelegramConfiguration({ settings: withDiscord });
		expect(discordResult.globallyDisabled).toBe(false);
		expect(discordCommits).toEqual([
			[
				{ path: "notifications.telegram.botToken", op: "unset" },
				{ path: "notifications.telegram.chatId", op: "unset" },
			],
		]);

		const { writer: telegramOnly, commits: telegramOnlyCommits } = writer();
		const telegramOnlyResult = await removeTelegramConfiguration({ settings: telegramOnly });
		expect(telegramOnlyResult.globallyDisabled).toBe(true);
		expect(telegramOnlyCommits).toEqual([
			[
				{ path: "notifications.telegram.botToken", op: "unset" },
				{ path: "notifications.telegram.chatId", op: "unset" },
				{ path: "notifications.enabled", op: "set", value: false },
			],
		]);
	});
});

describe("notification orchestration blocked runtime", () => {
	test("post-commit blocked identity stops the endpoint before completion and permits only CAS restore", async () => {
		const events: string[] = [];
		const commits: SettingsAtomicPatch[][] = [];
		let endpointRunning = true;
		let framesAfterBlock = 0;
		let discarded = false;
		const committedReceipt = receipt(() => {
			discarded = true;
		});
		const settings: NotificationConfigurationWriter = {
			getAgentDir: () => "/tmp/gjc-notification-orchestration",
			getNotificationSettingsSnapshot: () => snapshot(),
			commitAtomicBatch: async patches => {
				events.push("durable-commit");
				commits.push(structuredClone(patches) as SettingsAtomicPatch[]);
				return committedReceipt;
			},
		};
		const controller = {
			enterBlockedRuntime: async () => {
				events.push("stop-current-endpoint");
				endpointRunning = false;
			},
			clearBlockedRuntime: async () => events.push("clear-blocked-runtime"),
			reconcileCurrentSession: async () => events.push("normal-reconcile"),
		};

		const result = await saveTelegramConfiguration({
			settings,
			botToken: TOKEN,
			chatId: "new-chat",
			saveInactive: false,
			preflight: async () => ({ status: "absent" }),
			activation: {
				controller,
				reconnect: async () => {
					events.push("identity-reconnect");
					return "blocked_identity";
				},
			},
		});
		if (endpointRunning) framesAfterBlock++;

		expect(result.status).toBe("blocked_identity");
		expect(events).toEqual(["durable-commit", "identity-reconnect", "stop-current-endpoint"]);
		expect(commits).toEqual([
			[
				{ path: "notifications.telegram.botToken", op: "set", value: TOKEN },
				{ path: "notifications.telegram.chatId", op: "set", value: "new-chat" },
				{ path: "notifications.enabled", op: "set", value: true },
			],
		]);
		expect(framesAfterBlock).toBe(0);
		expect(events).not.toContain("normal-reconcile");
		if (result.status === "blocked_identity") {
			expect(await result.restore()).toEqual({ status: "still_blocked" });
			result.retainCommitted();
		}
		expect(events).toEqual([
			"durable-commit",
			"identity-reconnect",
			"stop-current-endpoint",
			"identity-reconnect",
			"stop-current-endpoint",
		]);
		expect(discarded).toBe(true);
	});
});
