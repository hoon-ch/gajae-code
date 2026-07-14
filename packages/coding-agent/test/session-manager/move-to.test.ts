import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadEntriesFromFile,
	type SessionHeader,
	SessionManager,
} from "@gajae-code/coding-agent/session/session-manager";
import { stripOuterDoubleQuotes } from "@gajae-code/coding-agent/tools/path-utils";
import { getConfigRootDir, getSessionsDir, setAgentDir } from "@gajae-code/utils";

// -- helpers ----------------------------------------------------------------

import { resolveManagedScope } from "../../src/session/internal/managed-session-scope";
import { makeAssistantMessage } from "./helpers";

function getHeader(entries: unknown[]): SessionHeader | undefined {
	return entries.find(
		(e): e is SessionHeader => typeof e === "object" && e !== null && "type" in e && (e as any).type === "session",
	) as SessionHeader | undefined;
}

function hasAssistantEntry(entries: unknown[]): boolean {
	return entries.some(
		e =>
			typeof e === "object" &&
			e !== null &&
			"type" in e &&
			(e as any).type === "message" &&
			"message" in e &&
			(e as any).message?.role === "assistant",
	);
}

function managedDirectoryName(cwd: string): string {
	const sessionsRoot = getSessionsDir();
	const resolved = resolveManagedScope({
		cwd,
		agentDir: path.resolve(sessionsRoot, ".."),
		sessionsRoot,
	});
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	return resolved.scope.directoryName;
}

// -- stripOuterDoubleQuotes tests -------------------------------------------

describe("stripOuterDoubleQuotes", () => {
	it("strips matching double quotes", () => {
		expect(stripOuterDoubleQuotes('"C:\\Users\\test"')).toBe("C:\\Users\\test");
	});
	it("strips matching double quotes from POSIX paths", () => {
		expect(stripOuterDoubleQuotes('"/home/user/test"')).toBe("/home/user/test");
	});
	it("passes through unquoted paths", () => {
		expect(stripOuterDoubleQuotes("C:\\Users\\test")).toBe("C:\\Users\\test");
	});
	it("does not strip mismatched quotes", () => {
		expect(stripOuterDoubleQuotes('"mismatched')).toBe('"mismatched');
	});
	it("does not strip single quotes", () => {
		expect(stripOuterDoubleQuotes("'foo'")).toBe("'foo'");
	});
	it("does not strip a lone double quote", () => {
		expect(stripOuterDoubleQuotes('"')).toBe('"');
	});
	it("strips empty quoted string to empty", () => {
		expect(stripOuterDoubleQuotes('""')).toBe("");
	});
});

// -- moveTo() tests ---------------------------------------------------------

describe("SessionManager.moveTo", () => {
	let testAgentDir: string;
	let cwdA: string;
	let cwdB: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		testAgentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "gjc-move-test-"));
		setAgentDir(testAgentDir);
		cwdA = path.join(testAgentDir, "cwd-a");
		cwdB = path.join(testAgentDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });
	});

	afterEach(async () => {
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(testAgentDir, { recursive: true, force: true });
	});

	it("moves session file and updates header cwd (baseline)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(oldFile)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Reload and verify content
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("does not replace an existing destination transcript", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "source", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sourceFile = session.getSessionFile()!;
		const destinationDir = SessionManager.getDefaultSessionDir(cwdB);
		const destinationFile = path.join(destinationDir, path.basename(sourceFile));
		fs.writeFileSync(destinationFile, "unrelated destination\n");

		await expect(session.moveTo(cwdB)).rejects.toThrow();
		expect(fs.readFileSync(destinationFile, "utf8")).toBe("unrelated destination\n");
		expect(fs.existsSync(sourceFile)).toBe(true);
	});

	it("retains the authoritative source when a cross-device rollback follows an artifact conflict", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "source", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sourceFile = session.getSessionFile()!;
		const sourceContent = fs.readFileSync(sourceFile, "utf8");
		const { path: artifactPath } = await session.allocateArtifactPath("bash");
		if (!artifactPath) throw new Error("Expected artifact path");

		const destinationFile = path.join(SessionManager.getDefaultSessionDir(cwdB), path.basename(sourceFile));
		fs.mkdirSync(destinationFile.slice(0, -6), { recursive: true });
		const originalLink = fs.promises.link;
		const forceCrossDevice: typeof fs.promises.link = async () => {
			const error = new Error("cross-device link") as NodeJS.ErrnoException;
			error.code = "EXDEV";
			throw error;
		};
		fs.promises.link = forceCrossDevice;
		try {
			await expect(session.moveTo(cwdB)).rejects.toThrow();
		} finally {
			fs.promises.link = originalLink;
		}

		expect(fs.readFileSync(sourceFile, "utf8")).toBe(sourceContent);
		expect(fs.existsSync(destinationFile)).toBe(false);
		expect(fs.existsSync(path.dirname(artifactPath))).toBe(true);
	});

	it("preserves complete nested artifact topology on a successful EXDEV move", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "source", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		const sourceFile = session.getSessionFile()!;
		const { path: artifactPath } = await session.allocateArtifactPath("bash");
		if (!artifactPath) throw new Error("Expected artifact path");
		const sourceArtifacts = path.dirname(artifactPath);
		await fsp.mkdir(path.join(sourceArtifacts, "nested", "empty"), { recursive: true });
		await fsp.writeFile(artifactPath, "top-level artifact");
		await fsp.writeFile(path.join(sourceArtifacts, "nested", "payload.txt"), "nested artifact");

		const originalLink = fs.promises.link;
		const forceCrossDevice: typeof fs.promises.link = async () => {
			const error = new Error("cross-device link") as NodeJS.ErrnoException;
			error.code = "EXDEV";
			throw error;
		};
		fs.promises.link = forceCrossDevice;
		try {
			await session.moveTo(cwdB);
		} finally {
			fs.promises.link = originalLink;
		}

		const destinationFile = session.getSessionFile()!;
		const destinationArtifacts = destinationFile.slice(0, -6);
		expect(fs.existsSync(sourceFile)).toBe(false);
		expect(fs.existsSync(sourceArtifacts)).toBe(false);
		expect(await fsp.readFile(path.join(destinationArtifacts, path.basename(artifactPath)), "utf8")).toBe(
			"top-level artifact",
		);
		expect(await fsp.readFile(path.join(destinationArtifacts, "nested", "payload.txt"), "utf8")).toBe(
			"nested artifact",
		);
		expect((await fsp.stat(path.join(destinationArtifacts, "nested", "empty"))).isDirectory()).toBe(true);
	});

	it("succeeds on fresh session without ENOENT, then deferred persistence works", async () => {
		const session = SessionManager.create(cwdA);
		// No messages — file never written to disk
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		// Lazy-persist preserved: no header-only .jsonl created
		expect(fs.existsSync(newFile)).toBe(false);

		// Verify deferred persistence at the new path
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();

		expect(fs.existsSync(newFile)).toBe(true);
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("recreates file from memory when old file is deleted (assistant exists)", async () => {
		const session = SessionManager.create(cwdA);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		await session.close();

		const oldFile = session.getSessionFile()!;
		// Delete the file to simulate unexpected removal
		await fsp.unlink(oldFile);
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);

		// Verify content recreated from memory
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
		expect(hasAssistantEntry(entries)).toBe(true);
	});

	it("moves header-only session and rewrites cwd", async () => {
		// Create a header-only session via open() with a non-existent explicit path
		const explicitPath = path.join(cwdA, "explicit-session.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);
		expect(path.dirname(newFile)).toBe(path.join(getSessionsDir(), managedDirectoryName(cwdB)));
		const reopened = await SessionManager.open(newFile);
		try {
			expect(reopened.getCwd()).toBe(path.resolve(cwdB));
			expect(reopened.getSessionFile()).toBe(newFile);
		} finally {
			await reopened.close();
		}

		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves header-only session with pending user message (#flushed regression)", async () => {
		// Create a header-only session
		const explicitPath = path.join(cwdA, "explicit-session-2.jsonl");
		const session = await SessionManager.open(explicitPath);

		expect(fs.existsSync(explicitPath)).toBe(true);

		// Add a user message only — _persist() sets #flushed=false (line 1827)
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		expect(fs.existsSync(explicitPath)).toBe(false);

		const newFile = session.getSessionFile()!;
		expect(fs.existsSync(newFile)).toBe(true);
		expect(path.dirname(newFile)).toBe(path.join(getSessionsDir(), managedDirectoryName(cwdB)));
		const reopened = await SessionManager.open(newFile);
		try {
			expect(reopened.getCwd()).toBe(path.resolve(cwdB));
			expect(reopened.getSessionFile()).toBe(newFile);
		} finally {
			await reopened.close();
		}

		// Rewrite must have run (hadSessionFile=true) even though #flushed was reset
		const entries = await loadEntriesFromFile(newFile);
		const header = getHeader(entries);
		expect(header?.cwd).toBe(path.resolve(cwdB));
	});

	it("moves artifact dir independently when session file does not exist", async () => {
		const session = SessionManager.create(cwdA);
		// Allocate an artifact — creates dir via ArtifactManager
		const { path: artifactPath } = await session.allocateArtifactPath("bash");
		if (!artifactPath) throw new Error("Expected artifact path");

		const oldArtifactDir = path.dirname(artifactPath);
		expect(fs.existsSync(oldArtifactDir)).toBe(true);

		// No messages — session file doesn't exist
		const oldFile = session.getSessionFile()!;
		expect(fs.existsSync(oldFile)).toBe(false);

		await session.moveTo(cwdB);

		expect(session.getCwd()).toBe(path.resolve(cwdB));
		// Old artifact dir moved
		expect(fs.existsSync(oldArtifactDir)).toBe(false);
		// New artifact dir exists
		const newFile = session.getSessionFile()!;
		const newArtifactDir = newFile.slice(0, -6); // strip .jsonl
		expect(fs.existsSync(newArtifactDir)).toBe(true);
	});
});
