import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES,
	NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT,
	NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS,
	NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS,
	type NotificationsSettingsShowcaseEntry,
	renderNotificationsSettingsShowcasePlaceholder,
} from "../test/fixtures/tui/notifications-settings-showcase";

const CANONICAL_COMMAND =
	"bun packages/coding-agent/scripts/capture-notifications-settings-showcase.ts --output .gjc/qa/issue-2050-notifications";
const DETERMINISTIC_CAPTURE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const CAPTURE_TOOL_VERSION = "notifications-settings-showcase-scaffold-v1";

interface ArtifactFile {
	path: string;
	sha256: string;
	byte_length: number;
}

interface ManifestEntry {
	key: string;
	state_id: string;
	viewport: {
		id: string;
		columns: number;
		rows: number;
	};
	render_mode: string;
	capture_mode: "fixture-placeholder";
	files: ArtifactFile[];
}

function usage(): never {
	throw new Error(`Usage: ${CANONICAL_COMMAND}`);
}

function parseOutputPath(args: string[]): string {
	if (args.length !== 2 || args[0] !== "--output" || !args[1]) usage();
	return args[1];
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render the limited deterministic SGR palette emitted by the placeholder. */
function ansiToHtml(text: string): string {
	const sgr = /\x1b\[([0-9;]*)m/g;
	let html = "";
	let offset = 0;
	let open = false;
	let styles: string[] = [];

	const close = () => {
		if (open) {
			html += "</span>";
			open = false;
		}
	};
	const openCurrent = () => {
		if (styles.length > 0) {
			html += `<span style="${styles.join(";")}">`;
			open = true;
		}
	};

	for (const match of text.matchAll(sgr)) {
		html += escapeHtml(text.slice(offset, match.index));
		offset = (match.index ?? 0) + match[0].length;
		close();
		const codes = (match[1] || "0").split(";").map(Number);
		for (const code of codes) {
			if (code === 0) {
				styles = [];
			} else if (code === 1 && !styles.includes("font-weight:700")) {
				styles.push("font-weight:700");
			} else if (code === 33) {
				styles = styles.filter(style => !style.startsWith("color:"));
				styles.push("color:#b58900");
			} else if (code === 36) {
				styles = styles.filter(style => !style.startsWith("color:"));
				styles.push("color:#008b8b");
			}
		}
		openCurrent();
	}
	close();
	html += escapeHtml(text.slice(offset));
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<title>Notifications settings showcase</title>
<style>body{margin:0;background:#111;color:#eee}pre{margin:0;padding:1em;white-space:pre-wrap;font-family:ui-monospace,monospace;line-height:1.2}</style>
</head>
<body><pre>${html}</pre></body>
</html>
`;
}

function validateShowcaseMatrix(entries: readonly NotificationsSettingsShowcaseEntry[]): void {
	const expectedBaselineCount =
		NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS.length * NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS.length;
	if (expectedBaselineCount !== 84) {
		throw new Error(`Baseline matrix changed: expected 84 entries, received ${expectedBaselineCount}`);
	}
	if (entries.length !== NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT) {
		throw new Error(
			`Showcase matrix changed: expected ${NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT} entries, received ${entries.length}`,
		);
	}
	const keys = new Set(entries.map(entry => entry.key));
	if (keys.size !== entries.length) throw new Error("Showcase matrix contains duplicate entry keys");

	for (const stateId of NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS) {
		for (const viewport of NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS) {
			const key = `${stateId}/${viewport.id}/unicode-color`;
			if (!keys.has(key)) throw new Error(`Showcase matrix is missing ${key}`);
		}
	}

	const expectedAsciiKeys = new Set([
		"home-configured-inactive/80x24/ascii-no-color",
		"health-warning/80x24/ascii-no-color",
		"foreign-blocked/120x36/ascii-no-color",
		"confirmation-remove/80x24/ascii-no-color",
	]);
	const actualAsciiKeys = entries.filter(entry => entry.renderMode === "ascii-no-color").map(entry => entry.key);
	if (actualAsciiKeys.length !== expectedAsciiKeys.size || actualAsciiKeys.some(key => !expectedAsciiKeys.has(key))) {
		throw new Error("Showcase matrix does not contain the required ASCII/no-color variants");
	}
}

async function writeArtifact(filePath: string, content: string, outputRoot: string): Promise<ArtifactFile> {
	await Bun.write(filePath, content);
	return {
		path: path.relative(outputRoot, filePath).split(path.sep).join("/"),
		sha256: sha256(content),
		byte_length: Buffer.byteLength(content, "utf8"),
	};
}

async function captureEntry(entry: NotificationsSettingsShowcaseEntry, outputRoot: string): Promise<ManifestEntry> {
	const rendered = renderNotificationsSettingsShowcasePlaceholder(entry);
	const entryDirectory = path.join(outputRoot, entry.stateId, entry.viewport.id, entry.renderMode);
	await fs.mkdir(entryDirectory, { recursive: true });

	const terminalHtml = ansiToHtml(rendered.terminalAnsiText);
	const metadata = json({
		schema_version: 1,
		entry_key: entry.key,
		state_id: entry.stateId,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		capture_mode: "fixture-placeholder",
		capture_timestamp: DETERMINISTIC_CAPTURE_TIMESTAMP,
		command_or_replay_source: CANONICAL_COMMAND,
		fixture_source: "packages/coding-agent/test/fixtures/tui/notifications-settings-showcase.ts",
		tool_version: CAPTURE_TOOL_VERSION,
		terminal: {
			columns: entry.viewport.columns,
			rows: entry.viewport.rows,
			font_rendering_assumptions:
				"Fixture placeholder rendered as monospace HTML; live PTY/font capture is pending Work item 7.",
			wrapping_policy:
				"Placeholder preserves semantic localized sentences; Work item 7 must capture the editor's ANSI-aware cell wrapping.",
			ansi_control_semantics:
				"terminal-ansi.txt preserves emitted SGR sequences; no cursor-position control sequences are emitted by the scaffold.",
		},
		editor_render: {
			status: "pending-work-item-7",
			placeholder: rendered.placeholder,
			note: "This artifact proves the 88-entry capture contract only. It is not live editor visual-QA evidence.",
		},
	});

	const files = await Promise.all([
		writeArtifact(path.join(entryDirectory, "terminal.txt"), rendered.terminalText, outputRoot),
		writeArtifact(path.join(entryDirectory, "terminal-ansi.txt"), rendered.terminalAnsiText, outputRoot),
		writeArtifact(path.join(entryDirectory, "terminal.html"), terminalHtml, outputRoot),
		writeArtifact(path.join(entryDirectory, "metadata.json"), metadata, outputRoot),
	]);

	return {
		key: entry.key,
		state_id: entry.stateId,
		viewport: entry.viewport,
		render_mode: entry.renderMode,
		capture_mode: "fixture-placeholder",
		files,
	};
}

async function main(): Promise<void> {
	const outputRoot = path.resolve(parseOutputPath(process.argv.slice(2)));
	validateShowcaseMatrix(NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES);
	await fs.mkdir(outputRoot, { recursive: true });

	const entries: ManifestEntry[] = [];
	for (const entry of NOTIFICATIONS_SETTINGS_SHOWCASE_ENTRIES) {
		entries.push(await captureEntry(entry, outputRoot));
	}

	const manifest = json({
		schema_version: 1,
		capture_tool: CAPTURE_TOOL_VERSION,
		capture_mode: "fixture-placeholder",
		command: CANONICAL_COMMAND,
		expected_entry_count: NOTIFICATIONS_SETTINGS_SHOWCASE_EXPECTED_ENTRY_COUNT,
		entry_count: entries.length,
		matrix: {
			canonical_state_ids: NOTIFICATIONS_SETTINGS_SHOWCASE_STATE_IDS,
			viewports: NOTIFICATIONS_SETTINGS_SHOWCASE_VIEWPORTS,
			baseline_render_mode: "unicode-color",
			ascii_no_color_variant_count: 4,
		},
		entries,
	});
	await Bun.write(path.join(outputRoot, "manifest.json"), manifest);

	process.stdout.write(
		`Captured ${entries.length} deterministic Notifications showcase scaffold entries to ${outputRoot}\nmanifest.json sha256: ${sha256(manifest)}\n`,
	);
}

await main();
