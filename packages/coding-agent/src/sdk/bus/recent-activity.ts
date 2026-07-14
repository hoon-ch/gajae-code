/**
 * Recent-activity session picker (G006).
 *
 * Ranks GJC sessions by session-history file mtime (most recent first) and
 * enriches each with terminal-breadcrumb info, so a remote lifecycle client can
 * pick a repo to create in or a recent session to resume without typing raw
 * paths. Dependency-light + injectable so it is unit-testable over a temp dir.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { verifyOwnerOnlyPathSecurity } from "@gajae-code/natives";
import { FileSessionStorage } from "../../session/session-storage";
import {
	type LogicalSessionCandidate,
	listManagedSessionCandidates,
	resolveManagedSessionScope,
} from "../session-directory";

/** One ranked recent-session entry surfaced to the picker. */
export interface RecentSessionEntry {
	/** Session id from the validated managed candidate header. */
	sessionId: string;
	/** Validated workspace path recorded by the managed candidate. */
	path?: string;
	/** Branch, when recoverable from the header. */
	branch?: string;
	/** A short title (first user message), when recoverable. */
	title?: string;
	/** Absolute path of the session history (state) file. */
	sessionStateFile: string;
	/** Last-activity epoch-millis (history file mtime). */
	mtimeMs: number;
	/** True when a terminal breadcrumb points at this session file. */
	currentTerminal?: boolean;
	/** True when this history is an internal helper/sub-agent session. */
	internal?: boolean;
}

export interface RecentActivityDeps {
	/** Workspace whose managed sessions will be listed readonly. */
	cwd: string;
	/** Agent directory used to resolve the managed session scope. */
	agentDir?: string;
	/** Explicit managed root for isolated tests. */
	sessionsRoot?: string;
	/** Optional breadcrumb session-file paths (current terminals). */
	breadcrumbPaths?: string[];
	/** Max entries to return (default 20). */
	limit?: number;
	/** Include internal helper/sub-agent sessions (default true). */
	includeInternal?: boolean;
	/** Injection seam for tests. */
	readInitialLines?: (file: string, maxLines: number) => string[];
}

function readCandidateInitialLines(
	candidate: LogicalSessionCandidate,
	readInitialLines: ((file: string, maxLines: number) => string[]) | undefined,
): string[] {
	if (readInitialLines) return readInitialLines(candidate.path, 8);
	const security = verifyOwnerOnlyPathSecurity(candidate.path, "file");
	if (!security.ok) throw new Error(`Managed session metadata path is unsafe: ${security.code}`);
	const snapshot = new FileSessionStorage().readSnapshotSync(candidate.path);
	const digest = createHash("sha256").update(snapshot.bytes).digest("hex");
	if (
		snapshot.stat.dev !== candidate.identity.dev ||
		snapshot.stat.ino !== candidate.identity.ino ||
		snapshot.stat.size !== candidate.identity.size ||
		snapshot.stat.mtimeNs !== candidate.identity.mtimeNs ||
		digest !== candidate.identity.sha256
	)
		throw new Error("Managed session changed after ownership was verified.");
	return Buffer.from(snapshot.bytes).toString("utf8").split("\n").slice(0, 8);
}

/** Best-effort header metadata extraction from a session file's first line. */
function headerMeta(line: string | undefined): { branch?: string; title?: string } {
	if (!line) return {};
	try {
		const obj = JSON.parse(line) as Record<string, unknown>;
		const branch = typeof obj.branch === "string" ? obj.branch : undefined;
		const title = typeof obj.title === "string" ? obj.title : undefined;
		return { branch, title };
	} catch {
		return {};
	}
}

/** Detect task-tool helper sessions from the durable early session_init metadata entry. */
function isInternalSession(lines: readonly string[]): boolean {
	for (const line of lines.slice(1)) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as unknown;
			if (typeof obj === "object" && obj !== null && (obj as { type?: unknown }).type === "session_init") {
				return true;
			}
		} catch {
			// Ignore malformed JSONL entries; classification is best-effort.
		}
	}
	return false;
}

/** Lists readonly managed candidates for one workspace, ranked by history-file mtime. */
export type ListRecentSessionsResult =
	| { kind: "complete"; entries: RecentSessionEntry[]; warnings: readonly string[] }
	| { kind: "error"; code: "scope_unavailable" | "managed_scan_failed"; message: string };

export async function listRecentSessions(deps: RecentActivityDeps): Promise<ListRecentSessionsResult> {
	const limit = deps.limit ?? 20;
	const includeInternal = deps.includeInternal ?? true;
	const readInitialLines = deps.readInitialLines;
	const breadcrumbs = new Set((deps.breadcrumbPaths ?? []).map(p => path.resolve(p)));
	const scope = await resolveManagedSessionScope({
		cwd: deps.cwd,
		agentDir: deps.agentDir,
		sessionsRoot: deps.sessionsRoot,
	});
	if (scope.kind !== "resolved") return { kind: "error", code: "scope_unavailable", message: scope.message };
	const listed = await listManagedSessionCandidates({ scope: scope.scope });
	if (listed.kind !== "complete") return { kind: "error", code: "managed_scan_failed", message: listed.message };

	const entries: RecentSessionEntry[] = [];
	for (const candidate of listed.owned) {
		let initialLines: string[];
		try {
			initialLines = readCandidateInitialLines(candidate, readInitialLines);
		} catch (error) {
			return {
				kind: "error",
				code: "managed_scan_failed",
				message: `Could not read managed session metadata: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		const meta = headerMeta(initialLines[0]);
		const internal = isInternalSession(initialLines);
		if (internal && !includeInternal) continue;
		entries.push({
			sessionId: candidate.sessionId,
			path: candidate.cwd,
			branch: meta.branch,
			title: meta.title,
			sessionStateFile: candidate.path,
			mtimeMs: candidate.identity.mtimeMs,
			currentTerminal: breadcrumbs.has(path.resolve(candidate.path)) || undefined,
			internal: internal || undefined,
		});
	}
	entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return {
		kind: "complete",
		entries: entries.slice(0, limit),
		warnings: listed.invalid.map(invalid => `Ignored invalid managed session candidate: ${invalid.code}`),
	};
}
