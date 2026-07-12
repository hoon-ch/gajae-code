/**
 * Notify CLI command handlers.
 *
 * Handles `gjc notify` setup/status and the hidden daemon entrypoint.
 */
import { createInterface } from "node:readline/promises";
import { APP_NAME } from "@gajae-code/utils/dirs";
import chalk from "chalk";
import type { Settings, SettingsAtomicPatch } from "../config/settings";

import { getNotificationConfig, maskToken } from "../notifications/config";
import {
	buildNotificationStatusReport,
	checkNotificationHealth,
	formatNotificationHealthReport,
	formatNotificationRecoveryReport,
	formatNotificationStatusReport,
	formatNotificationTestResult,
	recoverNotifications,
	sanitizeDiagnostic,
	sendNotificationTest,
} from "../notifications/notification-service";
import { readDaemonState } from "../notifications/telegram-daemon";
import {
	runTelegramSetup,
	type TelegramSetupPreflight,
	type TelegramSetupTimers,
} from "../notifications/telegram-setup";

export type NotifyAction = "setup" | "status" | "health" | "test" | "recovery" | "daemon-internal";

export interface NotifyCommandArgs {
	action: NotifyAction;
	smoke?: boolean;
	rawArgs: string[];
	token?: string;
	chatId?: string;
	redact?: boolean;
	probe?: boolean;
	message?: string;
}

export interface NotifyCommandDeps {
	fetchImpl?: typeof fetch;
	apiBase?: string;
	settings?: Settings;
	setupToken?: string;
	pollTimeoutMs?: number;
	pollIntervalMs?: number;
	setupChatId?: string;
	setupRedact?: boolean;
	setupInteractive?: boolean;
	threadedModePrompt?: (message: string) => Promise<string>;
	tokenPrompt?: () => Promise<string>;
	setExitCode?: (code: number) => void;
	exitProcess?: (code: number) => void;
	/** Optional daemon ownership facts collected by an embedding host. */
	setupPreflight?: TelegramSetupPreflight;
	/** Injectable timers and cancellation for setup pairing. */
	setupTimers?: TelegramSetupTimers;
	setupAbortSignal?: AbortSignal;
	setupPidAlive?: (pid: number) => boolean;
}

export function parseNotifyArgs(args: string[]): NotifyCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "notify") {
		return undefined;
	}

	const action = args[1];
	if (action === "setup" || action === "status") {
		const rest = args.slice(2);
		const flag = (name: string): string | undefined => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		return {
			action,
			rawArgs: rest,
			token: flag("--token"),
			chatId: flag("--chat-id"),
			redact: rest.includes("--redact"),
		};
	}
	if (action === "health" || action === "test" || action === "recovery") {
		const rest = args.slice(2);
		const flag = (name: string): string | undefined => {
			const i = rest.indexOf(name);
			return i >= 0 ? rest[i + 1] : undefined;
		};
		return {
			action,
			rawArgs: rest,
			probe: rest.includes("--probe"),
			message: flag("--message"),
		};
	}
	if (action === "daemon-internal") {
		return {
			action,
			smoke: args.slice(2).includes("--smoke"),
			rawArgs: args.slice(2),
		};
	}

	return { action: "status", rawArgs: args.slice(1) };
}

export async function runNotifyCommand(cmd: NotifyCommandArgs, deps: NotifyCommandDeps = {}): Promise<void> {
	switch (cmd.action) {
		case "setup":
			await runSetup({
				...deps,
				setupToken: deps.setupToken ?? cmd.token,
				setupChatId: deps.setupChatId ?? cmd.chatId,
				setupRedact: deps.setupRedact ?? cmd.redact,
			});
			return;
		case "status":
			await runStatus(deps);
			return;
		case "health":
			await runHealth(deps, cmd);
			return;
		case "test":
			await runTest(deps, cmd);
			return;
		case "recovery":
			await runRecovery(deps);
			return;
		case "daemon-internal": {
			const m = await import("../notifications/telegram-daemon-cli");
			if (cmd.smoke) {
				await m.runDaemonSmoke();
			} else {
				await m.runDaemonInternal(cmd.rawArgs);
			}
			return;
		}
	}
}

export async function runNotifyCliCommand(cmd: NotifyCommandArgs, deps: NotifyCommandDeps = {}): Promise<void> {
	try {
		await runNotifyCommand(cmd, deps);
	} catch (error) {
		if (cmd.action !== "setup" || !(error instanceof Error)) {
			throw error;
		}

		const cancelled =
			error.message === "Telegram bot token prompt cancelled." || error.message === "Telegram setup cancelled.";

		process.stderr.write(cancelled ? "Telegram notify setup cancelled.\n" : `Error: ${error.message}\n`);
		const code = cancelled ? 130 : 1;
		if (deps.setExitCode) {
			deps.setExitCode(code);
		} else {
			process.exitCode = code;
		}
		const exitProcess = deps.exitProcess ?? (deps.setExitCode ? undefined : process.exit);
		exitProcess?.(code);
	}
}

async function getSettings(deps: NotifyCommandDeps): Promise<Settings> {
	if (deps.settings) return deps.settings;
	const { Settings } = await import("../config/settings");
	return await Settings.init();
}

async function runSetup(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const token = deps.setupToken ?? (await (deps.tokenPrompt ?? promptForToken)());
	if (!token.trim()) {
		throw new Error("Telegram bot token is required.");
	}

	const result = await runTelegramSetup({
		token,
		preflight: deps.setupPreflight ?? (await resolveSetupPreflight(settings, deps)),
		chatId: deps.setupChatId,
		interactive: resolveSetupInteractive(deps),
		threadedModePrompt: deps.threadedModePrompt ?? promptForThreadedMode,
		pollTimeoutMs: deps.pollTimeoutMs,
		pollIntervalMs: deps.pollIntervalMs,
		signal: deps.setupAbortSignal,
		deps: {
			fetchImpl: deps.fetchImpl ?? globalThis.fetch,
			apiBase: deps.apiBase,
			timers: deps.setupTimers,
		},
		onEvent: event => {
			const output = event.kind === "rejected_chat" ? process.stderr : process.stdout;
			output.write(event.message);
		},
	});
	if (!result.ok) throw new Error(result.detail);
	if (result.pairingSource === "provided") {
		process.stdout.write(`Using provided chat id ${result.chatId} (non-interactive).\n`);
	}

	try {
		const patches: SettingsAtomicPatch[] = [
			{ path: "notifications.telegram.botToken", op: "set", value: token.trim() },
			{ path: "notifications.telegram.chatId", op: "set", value: result.chatId },
			{ path: "notifications.enabled", op: "set", value: true },
		];
		if (deps.setupRedact) patches.push({ path: "notifications.redact", op: "set", value: true });
		await settings.commitAtomicBatch(patches);
	} catch (error) {
		const detail = sanitizeDiagnostic(error instanceof Error ? error.message : "unknown persistence failure", token);
		throw new Error(`Unable to persist Telegram notification settings: ${detail}`);
	}

	process.stdout.write(
		`Notifications enabled. botToken=${maskToken(token)} chatId=${result.chatId} threaded=${result.threadedLabel}\n`,
	);
}

async function resolveSetupPreflight(settings: Settings, deps: NotifyCommandDeps): Promise<TelegramSetupPreflight> {
	if (deps.setupPreflight) return deps.setupPreflight;
	const cfg = getNotificationConfig(settings);
	try {
		const state = await readDaemonState(settings);
		if (!state) return { storedChatId: cfg.chatId };
		const validPid = Number.isSafeInteger(state.pid) && state.pid > 0;
		// Owner-proof: only block discovery for a daemon we can positively prove is
		// live (present state with a valid, alive pid). A malformed/no-pid record is
		// not evidence of a live poller, mirroring recoverNotifications' semantics.
		if (!validPid) return { storedChatId: cfg.chatId };
		return {
			storedChatId: cfg.chatId,
			daemon: {
				live: (deps.setupPidAlive ?? daemonPidAlive)(state.pid),
				tokenFingerprint: typeof state.tokenFingerprint === "string" ? state.tokenFingerprint : undefined,
			},
		};
	} catch {
		// A state read failure is not proof of a live daemon; proceed normally. The
		// daemon's own 409 handling remains the backstop against poller contention.
		return { storedChatId: cfg.chatId };
	}
}

function daemonPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

type TokenPromptInput = NodeJS.ReadStream & {
	isRaw?: boolean;
	setRawMode?: (mode: boolean) => unknown;
	pause?: () => unknown;
};

type TokenPromptOutput = Pick<NodeJS.WriteStream, "write">;

export async function promptForToken(
	input: TokenPromptInput = process.stdin,
	output: TokenPromptOutput = process.stdout,
): Promise<string> {
	if (!input.isTTY) {
		throw new Error("notify setup requires an interactive TTY unless setupToken is injected.");
	}
	if (typeof input.setRawMode !== "function") {
		throw new Error("notify setup requires a TTY with raw input support unless setupToken is injected.");
	}

	output.write("Telegram BotFather token: ");
	const wasRaw = input.isRaw === true;
	input.setRawMode(true);

	return await new Promise<string>((resolve, reject) => {
		let value = "";
		let settled = false;

		const cleanup = () => {
			input.off("data", onData);
			input.off("error", onError);
			input.setRawMode?.(wasRaw);
			input.pause?.();
			output.write("\n");
		};

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};

		const accept = () => finish(() => resolve(value.trim()));
		const cancel = () => finish(() => reject(new Error("Telegram bot token prompt cancelled.")));
		const onError = (error: Error) => finish(() => reject(error));
		const onData = (chunk: Buffer | string) => {
			for (const char of String(chunk)) {
				if (char === "\r" || char === "\n") {
					accept();
					return;
				}
				if (char === "\u0003") {
					cancel();
					return;
				}
				if (char === "\u0004") {
					if (value) accept();
					else cancel();
					return;
				}
				if (char === "\u007f" || char === "\b") {
					value = value.slice(0, -1);
					continue;
				}
				if (char >= " ") value += char;
			}
		};

		input.on("data", onData);
		input.once("error", onError);
		input.resume();
	});
}

function resolveSetupInteractive(deps: NotifyCommandDeps): boolean {
	if (deps.setupInteractive !== undefined) return deps.setupInteractive;
	return Boolean(process.stdin.isTTY) && !deps.setupChatId?.trim();
}

async function promptForThreadedMode(message: string): Promise<string> {
	if (!process.stdin.isTTY) return "skip";
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	try {
		return (await rl.question(message)).trim();
	} finally {
		rl.close();
	}
}

async function runStatus(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const report = buildNotificationStatusReport(settings);
	process.stdout.write(
		`${chalk.bold("Notifications")}\n${formatNotificationStatusReport(report).split("\n").slice(1).join("\n")}\n`,
	);
}

async function runHealth(deps: NotifyCommandDeps, cmd: NotifyCommandArgs): Promise<void> {
	const settings = await getSettings(deps);
	const report = await checkNotificationHealth({
		settings,
		probe: cmd.probe,
		deps: { fetchImpl: deps.fetchImpl, apiBase: deps.apiBase },
	});
	process.stdout.write(`${formatNotificationHealthReport(report)}\n`);
	if (report.overall === "error" && deps.setExitCode) deps.setExitCode(1);
	else if (report.overall === "error") process.exitCode = 1;
}

async function runTest(deps: NotifyCommandDeps, cmd: NotifyCommandArgs): Promise<void> {
	const settings = await getSettings(deps);
	const result = await sendNotificationTest({
		settings,
		text: cmd.message,
		deps: { fetchImpl: deps.fetchImpl, apiBase: deps.apiBase },
	});
	process.stdout.write(`${formatNotificationTestResult(result)}\n`);
	if (!result.ok && deps.setExitCode) deps.setExitCode(1);
	else if (!result.ok) process.exitCode = 1;
}

async function runRecovery(deps: NotifyCommandDeps): Promise<void> {
	const settings = await getSettings(deps);
	const report = await recoverNotifications({ settings });
	process.stdout.write(`${formatNotificationRecoveryReport(report)}\n`);
}

export function printNotifyHelp(): void {
	process.stdout.write(`${chalk.bold(`${APP_NAME} notify`)} - Configure Telegram notifications

${chalk.bold("Interactive path:")}
  In a running GJC session, use /settings → Notifications for setup, health, test, recovery,
  reconnect, global enable/disable, adapter-local Telegram removal, and session on/off.
  The CLI subcommands below remain the authoritative headless and automation fallback.

${chalk.bold("Usage:")}
  ${APP_NAME} notify setup
  ${APP_NAME} notify setup --token <botToken> --chat-id <chatId> [--redact]
  ${APP_NAME} notify status
  ${APP_NAME} notify health [--probe]
  ${APP_NAME} notify test [--message <text>]
  ${APP_NAME} notify recovery

${chalk.bold("Subcommands:")}
  setup     Pair a Telegram bot token with a private chat and verify Threaded Mode capability
  status    Show notification configuration without secrets
  health    Report config, daemon-ownership and endpoint health (--probe adds a Telegram reachability check)
  test      Send a one-off test notification through the configured Telegram adapter
  recovery  Clear dead-owner daemon locks and stale per-session endpoint files (never touches a live owner)

${chalk.bold("Examples:")}
  ${APP_NAME} notify setup
  ${APP_NAME} notify status
  ${APP_NAME} notify health --probe
  ${APP_NAME} notify test --message "hello from gjc"
  ${APP_NAME} notify recovery

${chalk.bold("Threaded Mode:")}
  GJC uses Telegram private-chat topics for per-session threads. Setup verifies the bot
  capability via getMe.has_topics_enabled. Enable Threaded Mode in @BotFather > Bot Settings
  > Threads Settings; bots cannot toggle it through the Bot API. If Telegram refuses topic
  creation at runtime, GJC delivers flat to the paired private chat with outbound notifications
  and inline ask buttons only, then nudges you to enable Threaded Mode for free-text replies
  and session commands.
`);
}
