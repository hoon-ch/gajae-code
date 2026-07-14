import { afterEach, describe, expect, it, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as native from "@gajae-code/natives";
import {
	deleteManagedSessionCandidate,
	listManagedCandidates,
	openManagedCandidateForWrite,
	prepareManagedSessionScopeForWrite,
	resolveManagedScope,
} from "../../src/session/internal/managed-session-scope";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

function legacyDirectory(sessionsRoot: string, cwd: string): string {
	return path.join(
		sessionsRoot,
		`--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`,
	);
}

function encoded(value: string): string {
	return value.replace(/[/\\:]/g, "-");
}

function legacyAbsoluteDirectory(sessionsRoot: string, cwd: string): string {
	return path.join(
		sessionsRoot,
		`--${path
			.resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`,
	);
}

async function writeLegacyTranscript(directory: string, id: string, cwd: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, `${id}.jsonl`), transcript(id, cwd));
}

function transcript(id: string, cwd: string, detail = ""): string {
	return `${JSON.stringify({ type: "session", id, timestamp: "2026-01-01T00:00:00.000Z", cwd })}\n${JSON.stringify({ type: "message", detail })}\n`;
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-write-"));
	temporaryDirectories.push(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const sessionsRoot = path.join(agentDir, "sessions");
	await fs.mkdir(cwd, { recursive: true });
	const resolved = resolveManagedScope({ cwd, agentDir, sessionsRoot });
	expect(resolved.kind).toBe("resolved");
	if (resolved.kind !== "resolved") throw new Error(resolved.message);
	return { cwd, sessionsRoot, scope: resolved.scope };
}

describe("managed session write protocol", () => {
	it("copy-retains a legacy candidate and coalesces it to its committed v2 transcript", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		await fs.mkdir(legacy, { recursive: true });
		const source = path.join(legacy, "2026-01-01_session-a.jsonl");
		await fs.writeFile(source, transcript("session-a", cwd));

		expect((await prepareManagedSessionScopeForWrite(scope)).kind).toBe("resolved");
		const listed = listManagedCandidates(scope);
		expect(listed.kind).toBe("complete");
		if (listed.kind !== "complete") return;
		const legacyCandidate = listed.owned.find(candidate => candidate.provenance === "legacy");
		expect(legacyCandidate).toBeDefined();
		if (!legacyCandidate) return;

		const first = await openManagedCandidateForWrite(scope, legacyCandidate);
		expect(first).toMatchObject({ kind: "opened", migrated: true });
		if (first.kind !== "opened") return;
		expect(first.path).toBe(path.join(scope.directoryPath, path.basename(source)));
		expect(await fs.readFile(source, "utf8")).toBe(transcript("session-a", cwd));

		const replay = await openManagedCandidateForWrite(scope, legacyCandidate);
		expect(replay).toMatchObject({ kind: "opened", path: first.path, migrated: true });
		const coalesced = listManagedCandidates(scope);
		expect(coalesced.kind).toBe("complete");
		if (coalesced.kind === "complete") {
			expect(coalesced.owned.filter(candidate => candidate.sessionId === "session-a")).toHaveLength(1);
			expect(coalesced.owned[0]?.provenance).toBe("v2");
			expect(coalesced.owned[0]?.migrationState).toBe("migrated_v2");
		}
		const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		for (const receipt of await fs.readdir(receipts)) await fs.unlink(path.join(receipts, receipt));
		const interruptedReplay = await openManagedCandidateForWrite(scope, legacyCandidate);
		expect(interruptedReplay).toMatchObject({ kind: "opened", path: first.path, migrated: true });
		expect(await fs.readdir(receipts)).toHaveLength(1);
	});
	it("quarantines and restores the complete legacy artifact topology before committing migration authority", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "topology.jsonl");
		const sourceArtifacts = source.slice(0, -6);
		await fs.mkdir(path.join(sourceArtifacts, "nested", "empty"), { recursive: true });
		await fs.writeFile(source, transcript("topology", cwd));
		await fs.writeFile(path.join(sourceArtifacts, "payload.txt"), "root");
		await fs.writeFile(path.join(sourceArtifacts, "nested", "payload.txt"), "nested");
		await fs.chmod(sourceArtifacts, 0o700);
		await fs.chmod(path.join(sourceArtifacts, "nested"), 0o700);
		await fs.chmod(path.join(sourceArtifacts, "nested", "empty"), 0o700);
		await fs.chmod(path.join(sourceArtifacts, "payload.txt"), 0o600);
		await fs.chmod(path.join(sourceArtifacts, "nested", "payload.txt"), 0o600);
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		const opened = await openManagedCandidateForWrite(scope, listed.owned[0]);
		if (opened.kind !== "opened") throw new Error(opened.message);
		const destinationArtifacts = opened.path.slice(0, -6);
		expect(await fs.readFile(path.join(destinationArtifacts, "payload.txt"), "utf8")).toBe("root");
		expect(await fs.readFile(path.join(destinationArtifacts, "nested", "payload.txt"), "utf8")).toBe("nested");
		expect((await fs.stat(path.join(destinationArtifacts, "nested", "empty"))).isDirectory()).toBe(true);
		expect(await fs.readFile(path.join(sourceArtifacts, "payload.txt"), "utf8")).toBe("root");
		expect((await fs.stat(path.join(sourceArtifacts, "nested", "empty"))).isDirectory()).toBe(true);
	});
	it("retains a detached legacy artifact root when exact restoration collides", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "restore-collision.jsonl");
		const sourceArtifacts = source.slice(0, -6);
		await fs.mkdir(sourceArtifacts, { recursive: true });
		await fs.writeFile(source, transcript("restore-collision", cwd));
		await fs.writeFile(path.join(sourceArtifacts, "payload.txt"), "authoritative");
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");
		const exactRestore = native.exactRestore;
		const restore = vi.spyOn(native, "exactRestore").mockImplementation((detachedPath, originalPath, identity) => {
			syncFs.mkdirSync(originalPath);
			return exactRestore(detachedPath, originalPath, identity);
		});
		try {
			await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			restore.mockRestore();
		}
		expect((await fs.stat(sourceArtifacts)).isDirectory()).toBe(true);
		const detached = (await fs.readdir(legacy)).find(
			name => name.startsWith(".gjc-migrate-") && name.endsWith("-artifacts"),
		);
		expect(detached).toBeDefined();
		if (!detached) throw new Error("Missing retained detached artifact root");
		expect(await fs.readFile(path.join(legacy, detached, "payload.txt"), "utf8")).toBe("authoritative");
		expect(await fs.readFile(source, "utf8")).toBe(transcript("restore-collision", cwd));
	});
	it("lists disabled legacy candidates read-only, rejects mutation, then migrates safely when re-enabled", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "policy.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("policy", cwd));

		const before = listManagedCandidates(scope);
		expect(before.kind).toBe("complete");
		if (before.kind !== "complete" || !before.owned[0]) throw new Error("Missing readonly legacy candidate");
		expect(before.owned[0]).toMatchObject({ provenance: "legacy", migrationState: "legacy_unmigrated" });
		const disabled = await openManagedCandidateForWrite(scope, before.owned[0], "disabled");
		expect(disabled).toMatchObject({ kind: "error", code: "legacy_migration_disabled" });
		expect(await fs.readFile(source, "utf8")).toBe(transcript("policy", cwd));
		await expect(fs.access(path.join(scope.directoryPath, "policy.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

		const reenabled = await openManagedCandidateForWrite(scope, before.owned[0]);
		expect(reenabled).toMatchObject({ kind: "opened", migrated: true });
		if (reenabled.kind !== "opened") throw new Error(reenabled.message);
		expect(await fs.readFile(source, "utf8")).toBe(transcript("policy", cwd));
		expect(await fs.readFile(reenabled.path, "utf8")).toBe(transcript("policy", cwd));
	});

	it("a fresh scope resumes a tombstoned exact-target cleanup without resurrecting either migration copy", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "restart.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("restart", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");
		const opened = await openManagedCandidateForWrite(scope, listed.owned[0]);
		if (opened.kind !== "opened") throw new Error(opened.message);

		const exactUnlink = vi.spyOn(native, "exactUnlink").mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			const interrupted = await deleteManagedSessionCandidate(scope, opened.candidate);
			expect(interrupted).toMatchObject({ kind: "error", code: "durability_failed" });
		} finally {
			exactUnlink.mockRestore();
		}
		const fresh = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		expect(fresh.kind).toBe("resolved");
		if (fresh.kind !== "resolved") throw new Error(fresh.message);
		const recovered = await deleteManagedSessionCandidate(fresh.scope, opened.candidate);
		expect(recovered.kind).toBe("already_deleted");
		expect(
			await fs.access(source).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			await fs.access(opened.path).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(listManagedCandidates(fresh.scope)).toMatchObject({ kind: "complete", owned: [] });
	});

	it("treats a symlinked committed receipt as untrusted and keeps the retained legacy transcript visible", async () => {
		if (process.platform === "win32") return;
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "receipt-link.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("receipt-link", cwd));
		const initial = listManagedCandidates(scope);
		if (initial.kind !== "complete" || !initial.owned[0]) throw new Error("Missing legacy candidate");
		const opened = await openManagedCandidateForWrite(scope, initial.owned[0]);
		if (opened.kind !== "opened") throw new Error(opened.message);
		const receipts = path.join(scope.directoryPath, ".gjc-managed-session-internal", "receipts");
		const [receipt] = await fs.readdir(receipts);
		if (!receipt) throw new Error("Missing committed receipt");
		const receiptPath = path.join(receipts, receipt);
		const externalReceipt = path.join(path.dirname(scope.directoryPath), "external-receipt.json");
		await fs.writeFile(externalReceipt, await fs.readFile(receiptPath));
		await fs.unlink(receiptPath);
		await fs.symlink(externalReceipt, receiptPath);

		const listed = listManagedCandidates(scope);
		expect(listed.kind).toBe("complete");
		if (listed.kind !== "complete") return;
		expect(
			listed.owned
				.filter(candidate => candidate.sessionId === "receipt-link")
				.map(candidate => candidate.provenance)
				.sort(),
		).toEqual(["legacy", "v2"]);
		expect(await fs.readFile(source, "utf8")).toBe(transcript("receipt-link", cwd));
	});

	it("rejects a preexisting symlink at the v2 destination without following or replacing it", async () => {
		if (process.platform === "win32") return;
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "destination-link.jsonl");
		const foreign = path.join(path.dirname(scope.directoryPath), "foreign-transcript.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("destination-link", cwd));
		await prepareManagedSessionScopeForWrite(scope);
		await fs.writeFile(foreign, "foreign transcript\n");
		const destination = path.join(scope.directoryPath, path.basename(source));
		await fs.symlink(foreign, destination);
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
			kind: "error",
			code: "destination_conflict",
		});
		expect(await fs.readFile(foreign, "utf8")).toBe("foreign transcript\n");
		expect(await fs.readFile(source, "utf8")).toBe(transcript("destination-link", cwd));
		expect((await fs.lstat(destination)).isSymbolicLink()).toBe(true);
	});

	it("rejects a substituted legacy source after candidate capture and preserves the replacement", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "substitution.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("substitution", cwd, "original"));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		await fs.unlink(source);
		const replacement = transcript("substitution", cwd, "replacement");
		await fs.writeFile(source, replacement);

		await expect(openManagedCandidateForWrite(scope, listed.owned[0])).resolves.toMatchObject({
			kind: "error",
			code: "source_changed",
		});
		expect(await fs.readFile(source, "utf8")).toBe(replacement);
		await expect(fs.access(path.join(scope.directoryPath, path.basename(source)))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("preserves corrupt legacy entries and refuses mutation from invalid authority", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		await fs.mkdir(legacy, { recursive: true });
		const corrupt = path.join(legacy, "corrupt.jsonl");
		await fs.writeFile(corrupt, "not-json\n");
		const listed = listManagedCandidates(scope);
		expect(listed).toMatchObject({ kind: "complete", invalid: [{ code: "unreadable_candidate" }] });
		expect(await fs.readFile(corrupt, "utf8")).toBe("not-json\n");
	});

	it("serializes concurrent migration and makes tombstoned deletion idempotent", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(path.join(legacy, "session.jsonl"), transcript("session-delete", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete") throw new Error(listed.message);
		const candidate = listed.owned[0];
		if (!candidate) throw new Error("Missing legacy candidate");

		const concurrent = await Promise.all([
			openManagedCandidateForWrite(scope, candidate),
			openManagedCandidateForWrite(scope, candidate),
		]);
		const openedResults = concurrent.filter(
			(result): result is Extract<typeof result, { kind: "opened" }> => result.kind === "opened",
		);
		expect(openedResults).toHaveLength(2);
		expect(new Set(openedResults.map(result => result.path)).size).toBe(1);
		expect(openedResults.every(result => result.migrated)).toBe(true);
		const opened = concurrent.find(
			(result): result is Extract<typeof result, { kind: "opened" }> => result.kind === "opened",
		);
		if (!opened) return;
		const deleted = await deleteManagedSessionCandidate(scope, opened.candidate);
		expect(deleted.kind).toBe("deleted");
		const replay = await deleteManagedSessionCandidate(scope, opened.candidate);
		expect(replay).toMatchObject({ kind: "already_deleted" });
		expect(await fs.stat((deleted as { tombstonePath: string }).tombstonePath)).toBeDefined();
	});
	it("enumerates the historical temp-relative legacy directory alongside the absolute spelling", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const tempRelative = path.relative(os.tmpdir(), cwd);
		await writeLegacyTranscript(legacyAbsoluteDirectory(sessionsRoot, cwd), "absolute", cwd);
		await writeLegacyTranscript(path.join(sessionsRoot, `---tmp-${encoded(tempRelative)}--`), "temp-relative", cwd);

		const listed = listManagedCandidates(scope);
		expect(listed.kind).toBe("complete");
		if (listed.kind !== "complete") return;
		expect(listed.owned.map(candidate => candidate.sessionId).sort()).toEqual(["absolute", "temp-relative"]);
	});

	it("enumerates historical home root and child directory spellings", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-home-"));
		temporaryDirectories.push(root);
		const sessionsRoot = path.join(root, "agent", "sessions");
		const home = os.homedir();
		const child = await fs.mkdtemp(path.join(home, ".gjc-managed-session-child-"));
		temporaryDirectories.push(child);
		const encodedHome = encoded(home);
		const relative = path.relative(home, child);
		const rootScope = resolveManagedScope({ cwd: home, agentDir: path.join(root, "agent"), sessionsRoot });
		const childScope = resolveManagedScope({ cwd: child, agentDir: path.join(root, "agent"), sessionsRoot });
		expect(rootScope.kind).toBe("resolved");
		expect(childScope.kind).toBe("resolved");
		if (rootScope.kind !== "resolved" || childScope.kind !== "resolved") return;

		await writeLegacyTranscript(path.join(sessionsRoot, `--${encodedHome}--`), "home-root", home);
		await writeLegacyTranscript(path.join(sessionsRoot, "----"), "home-relative-root", home);
		await writeLegacyTranscript(path.join(sessionsRoot, `---${encoded(relative)}--`), "home-relative", child);
		await writeLegacyTranscript(
			path.join(sessionsRoot, `--${encodedHome}-${encoded(relative)}--`),
			"old-home-child",
			child,
		);

		const rootListed = listManagedCandidates(rootScope.scope);
		const childListed = listManagedCandidates(childScope.scope);
		expect(rootListed).toMatchObject({ kind: "complete" });
		expect(childListed).toMatchObject({ kind: "complete" });
		if (rootListed.kind === "complete")
			expect(rootListed.owned.map(candidate => candidate.sessionId).sort()).toEqual([
				"home-relative-root",
				"home-root",
			]);
		if (childListed.kind === "complete")
			expect(childListed.owned.map(candidate => candidate.sessionId).sort()).toEqual([
				"home-relative",
				"old-home-child",
			]);
	});

	it("enumerates a lexical absolute legacy spelling when canonical identity resolves through an alias", async () => {
		if (process.platform === "win32") return;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-lexical-"));
		temporaryDirectories.push(root);
		const canonical = path.join(root, "workspace");
		const lexical = path.join(root, "workspace-alias");
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		await fs.mkdir(canonical);
		await fs.symlink(canonical, lexical);
		const resolved = resolveManagedScope({ cwd: lexical, agentDir, sessionsRoot });
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") return;
		await writeLegacyTranscript(legacyAbsoluteDirectory(sessionsRoot, lexical), "lexical", lexical);

		const listed = listManagedCandidates(resolved.scope);
		expect(listed).toMatchObject({ kind: "complete" });
		if (listed.kind === "complete") expect(listed.owned.map(candidate => candidate.sessionId)).toEqual(["lexical"]);
	});
	it("filters colliding legacy absolute directory entries by their transcript workspace identity", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-managed-collision-"));
		temporaryDirectories.push(root);
		const agentDir = path.join(root, "agent");
		const sessionsRoot = path.join(agentDir, "sessions");
		const first = path.join(root, "a-b", "c");
		const second = path.join(root, "a", "b-c");
		await Promise.all([fs.mkdir(first, { recursive: true }), fs.mkdir(second, { recursive: true })]);
		const firstScope = resolveManagedScope({ cwd: first, agentDir, sessionsRoot });
		const secondScope = resolveManagedScope({ cwd: second, agentDir, sessionsRoot });
		expect(firstScope.kind).toBe("resolved");
		expect(secondScope.kind).toBe("resolved");
		if (firstScope.kind !== "resolved" || secondScope.kind !== "resolved") return;
		const collisionDirectory = legacyAbsoluteDirectory(sessionsRoot, first);
		expect(collisionDirectory).toBe(legacyAbsoluteDirectory(sessionsRoot, second));
		await writeLegacyTranscript(collisionDirectory, "first", first);
		await writeLegacyTranscript(collisionDirectory, "second", second);

		const firstListed = listManagedCandidates(firstScope.scope);
		const secondListed = listManagedCandidates(secondScope.scope);
		if (firstListed.kind === "complete")
			expect(firstListed.owned.map(candidate => candidate.sessionId)).toEqual(["first"]);
		if (secondListed.kind === "complete")
			expect(secondListed.owned.map(candidate => candidate.sessionId)).toEqual(["second"]);
	});
	it("reconciles a crash-after-tombstone on a fresh scope without resurrecting the candidate", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "crash-restart.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("crash-restart", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing legacy candidate");

		const unlink = vi.spyOn(native, "exactUnlink").mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			unlink.mockRestore();
		}
		expect(await fs.stat(source)).toBeDefined();

		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		const afterRestart = listManagedCandidates(restarted.scope);
		expect(afterRestart).toMatchObject({ kind: "complete" });
		if (afterRestart.kind === "complete")
			expect(afterRestart.owned.some(candidate => candidate.sessionId === "crash-restart")).toBe(false);
	});
	it("reconciles detached artifact cleanup from an append-only sidecar on a fresh scope", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "detached-artifact-restart.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("detached-artifact-restart", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup interrupted"));
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			remove.mockRestore();
		}
		expect(await fs.stat(source)).toBeDefined();
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		expect(listManagedCandidates(restarted.scope)).toMatchObject({ kind: "complete", owned: [] });
	});

	it("recovers a crash after artifact detach but before the native result is persisted", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "crash-after-detach.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("crash-after-detach", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			const result = exactUnlink(pathname, identity);
			if (pathname === artifacts && identity.directory && result.ok) throw new Error("crash_after_detach");
			return result;
		});
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
			});
		} finally {
			unlink.mockRestore();
		}
		expect(await fs.stat(source)).toBeDefined();
		expect(await fs.stat(artifacts).catch(() => undefined)).toBeUndefined();
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
	});

	it("rejects a forged cleanup chain whose detached pathname was not planned by its predecessor", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "forged-cleanup-chain.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("forged-cleanup-chain", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const remove = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup interrupted"));
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			remove.mockRestore();
		}
		const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
		const firstName = (await fs.readdir(tombstones)).find(name => name.includes(".cleanup-pending-1"));
		if (!firstName) throw new Error("Missing initial cleanup receipt");
		const firstPath = path.join(tombstones, firstName);
		const first = JSON.parse(await fs.readFile(firstPath, "utf8")) as Record<string, unknown>;
		const forged = {
			...first,
			attempt: 2,
			detachedArtifactsPath: path.join(path.dirname(source), ".gjc-delete-forged-artifacts"),
			plannedArtifactsPath: path.join(path.dirname(source), ".gjc-delete-forged-next-artifacts"),
			plannedTranscriptPath: path.join(path.dirname(source), ".gjc-delete-forged-next-transcript"),
		};
		await fs.writeFile(firstPath.replace("cleanup-pending-1", "cleanup-pending-2"), JSON.stringify(forged));
		await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
			kind: "error",
			code: "durability_failed",
		});
		expect(await fs.stat(source)).toBeDefined();
	});

	it("reconciles transcript post-quarantine cleanup from a sidecar on a fresh scope", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "detached-transcript-restart.jsonl");
		await fs.mkdir(legacy, { recursive: true });
		await fs.writeFile(source, transcript("detached-transcript-restart", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const unlink = vi.spyOn(native, "exactUnlink").mockReturnValueOnce({ ok: false, code: "io_error" });
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			unlink.mockRestore();
		}
		expect(await fs.stat(source)).toBeDefined();
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		expect(listManagedCandidates(restarted.scope)).toMatchObject({ kind: "complete", owned: [] });
	});
	it("publishes a contiguous append-only quarantine chain before every repeated cleanup detach", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "repeat-detach.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("repeat-detach", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const remove = vi.spyOn(fs, "rm").mockRejectedValue(new Error("cleanup interrupted"));
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({
				kind: "error",
				code: "durability_failed",
			});
		} finally {
			remove.mockRestore();
		}
		const tombstones = path.join(scope.directoryPath, ".gjc-managed-session-internal", "tombstones");
		const pending = (await fs.readdir(tombstones)).filter(name => name.includes(".cleanup-pending-"));
		expect(pending.length).toBeGreaterThanOrEqual(3);
		const records = await Promise.all(
			pending.map(
				async name => JSON.parse(await fs.readFile(path.join(tombstones, name), "utf8")) as Record<string, unknown>,
			),
		);
		const attempts = records.map(record => record.attempt as number).sort((left, right) => left - right);
		expect(attempts).toEqual(Array.from({ length: attempts.length }, (_, index) => index + 1));
		const latestAttempt = attempts.at(-1)!;
		const latest = records.find(record => record.attempt === latestAttempt);
		expect(latest).toMatchObject({
			detachedArtifactsPath: expect.stringMatching(new RegExp(`-artifacts-${latestAttempt - 1}$`)),
			plannedArtifactsPath: expect.stringMatching(new RegExp(`-artifacts-${latestAttempt}$`)),
		});
		expect(await fs.stat(source)).toBeDefined();
	});
	it("reconciles a crash after durable artifact completion and successful transcript unlink", async () => {
		const { cwd, sessionsRoot, scope } = await fixture();
		const legacy = legacyDirectory(sessionsRoot, cwd);
		const source = path.join(legacy, "phase-receipt-crash.jsonl");
		const artifacts = source.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await fs.writeFile(path.join(artifacts, "artifact.txt"), "payload");
		await fs.writeFile(source, transcript("phase-receipt-crash", cwd));
		const listed = listManagedCandidates(scope);
		if (listed.kind !== "complete" || !listed.owned[0]) throw new Error("Missing candidate");
		const exactUnlink = native.exactUnlink;
		const unlink = vi.spyOn(native, "exactUnlink").mockImplementation((pathname, identity) => {
			const result = exactUnlink(pathname, identity);
			if (pathname === source && result.ok) throw new Error("crash_after_transcript_unlink");
			return result;
		});
		try {
			await expect(deleteManagedSessionCandidate(scope, listed.owned[0])).resolves.toMatchObject({ kind: "error" });
		} finally {
			unlink.mockRestore();
		}
		expect(await fs.stat(source).catch(() => undefined)).toBeUndefined();
		const restarted = resolveManagedScope({ cwd, agentDir: path.dirname(sessionsRoot), sessionsRoot });
		if (restarted.kind !== "resolved") throw new Error(restarted.message);
		expect((await prepareManagedSessionScopeForWrite(restarted.scope)).kind).toBe("resolved");
		expect(listManagedCandidates(restarted.scope)).toMatchObject({ kind: "complete", owned: [] });
	});
});
