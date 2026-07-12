import * as fs from "node:fs";
import * as path from "node:path";
import { YAML } from "bun";
import { withFileLock } from "../config/file-lock";
import type { Settings } from "../config/settings";
import {
	getNotificationConfig,
	isTelegramConfigured,
	type NotificationSettingsReader,
	type NotificationSettingsSnapshot,
} from "./config";
import { daemonPaths } from "./daemon-paths";
import type { TelegramDaemonOptions } from "./telegram-daemon";

type TelegramDaemonRunner = {
	run(): Promise<void>;
	requestStop(reason?: "reload" | "signal" | "stop"): void;
};

type TelegramDaemonConstructor = new (opts: TelegramDaemonOptions) => TelegramDaemonRunner;

export type LightweightDaemonSettings = Pick<Settings, "get" | "getAgentDir" | "set" | "flush"> &
	NotificationSettingsReader;

export interface RunDaemonInternalDeps {
	SettingsImpl?: {
		init: (options?: { agentDir?: string }) => Promise<LightweightDaemonSettings>;
	};
	DaemonImpl?: TelegramDaemonConstructor;
	processPid?: number;
	pidAlive?: (pid: number) => boolean;
}

function argValue(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}

function getByPath(obj: unknown, pathSegments: string[]): unknown {
	let current = obj;
	for (const segment of pathSegments) {
		if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function setByPath(obj: Record<string, unknown>, pathSegments: string[], value: unknown): void {
	let current = obj;
	for (let i = 0; i < pathSegments.length - 1; i++) {
		const segment = pathSegments[i]!;
		const next = current[segment];
		if (!next || typeof next !== "object" || Array.isArray(next)) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	current[pathSegments[pathSegments.length - 1]!] = value;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asIdleTimeoutMs(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 60_000;
}

export function createLightweightDaemonSettings(input: {
	agentDir: string;
	rawConfig?: unknown;
}): LightweightDaemonSettings {
	const rawConfig = input.rawConfig && typeof input.rawConfig === "object" ? input.rawConfig : {};
	const getNotificationSettingsSnapshot = (): NotificationSettingsSnapshot => ({
		enabled: asBoolean(getByPath(rawConfig, ["notifications", "enabled"]), false),
		telegram: {
			botToken: asString(getByPath(rawConfig, ["notifications", "telegram", "botToken"])),
			chatId: asString(getByPath(rawConfig, ["notifications", "telegram", "chatId"])),
			rich: {
				enabled: asBoolean(getByPath(rawConfig, ["notifications", "telegram", "rich", "enabled"]), true),
			},
			richDraft: {
				enabled: asBoolean(getByPath(rawConfig, ["notifications", "telegram", "richDraft", "enabled"]), false),
			},
			topics: {
				nameTemplate: asString(getByPath(rawConfig, ["notifications", "telegram", "topics", "nameTemplate"])),
			},
		},
		discord: {
			botToken: asString(getByPath(rawConfig, ["notifications", "discord", "botToken"])),
			channelId: asString(getByPath(rawConfig, ["notifications", "discord", "channelId"])),
		},
		slack: {
			botToken: asString(getByPath(rawConfig, ["notifications", "slack", "botToken"])),
			channelId: asString(getByPath(rawConfig, ["notifications", "slack", "channelId"])),
		},
		redact: asBoolean(getByPath(rawConfig, ["notifications", "redact"]), false),
		verbosity: getByPath(rawConfig, ["notifications", "verbosity"]) === "verbose" ? "verbose" : "lean",
		sessionScope: getByPath(rawConfig, ["notifications", "sessionScope"]) === "primary" ? "primary" : "all",
		idleTimeoutMs: asIdleTimeoutMs(getByPath(rawConfig, ["notifications", "daemon", "idleTimeoutMs"])),
	});

	return {
		get(pathName: string): unknown {
			const snapshot = getNotificationSettingsSnapshot();
			switch (pathName) {
				case "notifications.enabled":
					return snapshot.enabled;
				case "notifications.telegram.botToken":
					return snapshot.telegram.botToken;
				case "notifications.telegram.chatId":
					return snapshot.telegram.chatId;
				case "notifications.telegram.rich.enabled":
					return snapshot.telegram.rich.enabled;
				case "notifications.telegram.richDraft.enabled":
					return snapshot.telegram.richDraft.enabled;
				case "notifications.telegram.topics.nameTemplate":
					return snapshot.telegram.topics.nameTemplate;
				case "notifications.discord.botToken":
					return snapshot.discord.botToken;
				case "notifications.discord.channelId":
					return snapshot.discord.channelId;
				case "notifications.slack.botToken":
					return snapshot.slack.botToken;
				case "notifications.slack.channelId":
					return snapshot.slack.channelId;
				case "notifications.redact":
					return snapshot.redact;
				case "notifications.verbosity":
					return snapshot.verbosity;
				case "notifications.sessionScope":
					return snapshot.sessionScope;
				case "notifications.daemon.idleTimeoutMs":
					return snapshot.idleTimeoutMs;
				default:
					return undefined;
			}
		},
		getNotificationSettingsSnapshot,
		getAgentDir(): string {
			return input.agentDir;
		},
		async set(pathName: string, value: unknown): Promise<void> {
			// Back onto config.yml directly (the full Settings class is not loaded in
			// the spawned daemon process). Contend on the SAME per-file lock as
			// Settings.#saveNow and re-read UNDER the lock, patching only this key, so
			// a concurrent main-process save can never drop unrelated settings (no
			// whole-file last-writer-wins). The write is atomic (tmp + rename) so a
			// crash mid-write can never truncate config.yml, and any failure propagates
			// so the `/rich` handler leaves runtime state unchanged. The in-memory view
			// is updated only after the durable write succeeds.
			const segments = pathName.split(".");
			const configPath = path.join(input.agentDir, "config.yml");
			await withFileLock(configPath, async () => {
				let onDisk: Record<string, unknown> = {};
				try {
					const parsed = YAML.parse(await fs.promises.readFile(configPath, "utf8"));
					if (parsed && typeof parsed === "object") onDisk = parsed as Record<string, unknown>;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				setByPath(onDisk, segments, value);
				await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
				const tmpPath = `${configPath}.tmp.${process.pid}.${Date.now()}`;
				await fs.promises.writeFile(tmpPath, YAML.stringify(onDisk), { mode: 0o600 });
				await fs.promises.rename(tmpPath, configPath);
			});
			setByPath(rawConfig as Record<string, unknown>, segments, value);
		},
		async flush(): Promise<void> {
			// The set() above is synchronously durable (it awaits the atomic tmp+rename
			// write under the shared file lock), so there is never a pending save to
			// flush. Present so the daemon can await flush() uniformly regardless of
			// which Settings implementation is injected.
		},
	} as LightweightDaemonSettings;
}

export async function loadLightweightDaemonSettings(agentDir: string): Promise<LightweightDaemonSettings> {
	const configPath = path.join(agentDir, "config.yml");
	let rawConfig: unknown = {};
	try {
		rawConfig = YAML.parse(await fs.promises.readFile(configPath, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return createLightweightDaemonSettings({ agentDir, rawConfig });
}

async function resolveDaemonSettings(
	agentDir: string,
	deps: RunDaemonInternalDeps,
): Promise<LightweightDaemonSettings> {
	if (deps.SettingsImpl) return await deps.SettingsImpl.init({ agentDir });
	return await loadLightweightDaemonSettings(agentDir);
}

export function ownerPidFromOwnerId(ownerId: string): number | undefined {
	const match = /^(\d+)(?:-|$)/.exec(ownerId);
	if (!match) return undefined;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function ownerProcessIsAlive(ownerId: string, deps: RunDaemonInternalDeps): boolean {
	const ownerPid = ownerPidFromOwnerId(ownerId);
	if (ownerPid === undefined) return true;
	return (deps.pidAlive ?? defaultPidAlive)(ownerPid);
}

export async function runDaemonSmoke(opts: { agentDir?: string } = {}): Promise<void> {
	const agentDir = opts.agentDir ?? fs.mkdtempSync(path.join(process.cwd(), ".telegram-daemon-smoke-"));
	const settings = createLightweightDaemonSettings({ agentDir, rawConfig: {} });
	const paths = daemonPaths(agentDir);
	await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	const tempLock = `${paths.lock}.smoke.${process.pid}`;
	const handle = await fs.promises.open(tempLock, "wx", 0o600);
	await handle.close();
	await fs.promises.unlink(tempLock);
	void settings;
}

export async function runDaemonInternal(argv: string[], deps: RunDaemonInternalDeps = {}): Promise<void> {
	const smoke = argv.includes("--smoke");
	const agentDir = argValue(argv, "--agent-dir");
	if (smoke) return runDaemonSmoke({ agentDir });
	const ownerId = argValue(argv, "--owner-id");
	if (!ownerId) throw new Error("missing --owner-id");
	if (!ownerProcessIsAlive(ownerId, deps)) {
		process.stderr.write(`GJC notify daemon exiting: owner process from --owner-id ${ownerId} is not alive.\n`);
		return;
	}
	const resolvedAgentDir = agentDir ?? process.env.GJC_CODING_AGENT_DIR ?? path.join(process.cwd(), ".gjc", "agent");
	const settings = await resolveDaemonSettings(resolvedAgentDir, deps);
	const cfg = getNotificationConfig(settings);
	if (!isTelegramConfigured(cfg)) return;
	const { clearTelegramControlRequest, readTelegramControlRequest } = await import("./telegram-daemon-control");
	const Daemon: TelegramDaemonConstructor =
		deps.DaemonImpl ?? (await import("./telegram-daemon")).TelegramNotificationDaemon;
	const daemon = new Daemon({
		settings: settings as Settings,
		ownerId,
		botToken: cfg.botToken,
		chatId: cfg.chatId,
		idleTimeoutMs: cfg.idleTimeoutMs,
		rich: cfg.rich,
		richDraft: cfg.richDraft,
		topics: cfg.topics,
		pid: deps.processPid ?? process.pid,
		control: {
			shouldStop: async owner => {
				const req = await readTelegramControlRequest(settings as Settings);
				return Boolean(req && (!req.ownerId || req.ownerId === owner));
			},
			clear: async owner => {
				const req = await readTelegramControlRequest(settings as Settings);
				// Only clear a request that targets this daemon owner, so an exiting
				// daemon never erases a newer request meant for a different owner.
				if (req && (!req.ownerId || req.ownerId === owner)) {
					await clearTelegramControlRequest(settings as Settings, req.requestId);
				}
			},
		},
	});
	// Signals are a process concern: install them at the daemon-internal boundary,
	// not inside the embeddable daemon class. SIGTERM is the reload wakeup path.
	const onSignal = (): void => daemon.requestStop("signal");
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
	try {
		await daemon.run();
	} finally {
		process.off("SIGTERM", onSignal);
		process.off("SIGINT", onSignal);
	}
}
