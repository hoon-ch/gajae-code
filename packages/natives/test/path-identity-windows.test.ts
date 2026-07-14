import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	applyOwnerOnlyPathSecurity,
	canonicalExistingDirectoryIdentity,
	exactRestore,
	exactUnlink,
	verifyOwnerOnlyPathSecurity,
} from "../native/index.js";

const temporaryDirectories: string[] = [];

function sha256(contents: string): string {
	return createHash("sha256").update(contents).digest("hex");
}

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-path-identity-windows-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe.skipIf(process.platform !== "win32")("Windows native path identity", () => {
	it("rejects final and ancestor reparse points for every owner-only ACL operation", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const alias = path.join(root, "alias");
		const file = path.join(target, "state.json");
		await fs.mkdir(target);
		await fs.writeFile(file, "{}");
		await fs.symlink(target, alias, "junction");

		const rejected = { ok: false, code: "reparse_point" };
		expect(applyOwnerOnlyPathSecurity(alias, "directory")).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurity(alias, "directory")).toEqual(rejected);
		expect(applyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual(rejected);
		expect(verifyOwnerOnlyPathSecurity(path.join(alias, "state.json"), "file")).toEqual(rejected);
	});

	it("replaces inherited ACLs with a protected owner-only DACL without changing content", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "managed");
		const file = path.join(directory, "state.json");
		const contents = '{"preserve":"payload"}';
		await fs.mkdir(directory);
		await fs.writeFile(file, contents);

		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: false, code: "acl_verify_failed" });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: false, code: "acl_verify_failed" });
		expect(applyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(applyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(directory, "directory")).toEqual({ ok: true });
		expect(verifyOwnerOnlyPathSecurity(file, "file")).toEqual({ ok: true });
		expect(await fs.readFile(file, "utf8")).toBe(contents);
	});

	it("does not delete a replacement when exact handle identity differs", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "replacement.jsonl");
		await fs.writeFile(file, "replacement");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size + 1n,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("replacement"),
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(file, "utf8")).toBe("replacement");
	});

	it("retains a same-object content mutation when its authorized digest is stale", async () => {
		const root = await temporaryDirectory();
		const file = path.join(root, "state.jsonl");
		await fs.writeFile(file, "original");
		const authorizedDigest = sha256("original");
		await fs.writeFile(file, "mutated!");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: authorizedDigest,
			}),
		).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(file, "utf8")).toBe("mutated!");
	});

	it("atomically detaches only the identified directory to its preauthorized destination", async () => {
		const root = await temporaryDirectory();
		const directory = path.join(root, "artifact");
		const child = path.join(directory, "state.json");
		const quarantineName = ".gjc-delete-preauthorized";
		await fs.mkdir(directory);
		await fs.writeFile(child, "preserve");
		const stat = await fs.stat(directory, { bigint: true });

		const result = exactUnlink(directory, {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			directory: true,
			quarantineName,
		});
		expect(result).toEqual({ ok: true, detachedPath: path.join(root, quarantineName) });
		expect(
			await fs.stat(directory).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(await fs.readFile(path.join(result.detachedPath!, "state.json"), "utf8")).toBe("preserve");
	});
	it("keeps the detached authority when post-detach full-file digest verification succeeds", async () => {
		const root = await temporaryDirectory();
		const original = path.join(root, "state.jsonl");
		const detached = path.join(root, ".gjc-delete-state");
		const contents = "x".repeat(128 * 1024);
		await fs.writeFile(original, contents);
		const stat = await fs.stat(original, { bigint: true });

		expect(
			exactUnlink(original, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256(contents),
				quarantineName: path.basename(detached),
				detachOnly: true,
			}),
		).toEqual({ ok: true, detachedPath: detached });
		expect(await fs.readFile(detached, "utf8")).toBe(contents);
	});

	it("restores a handle-bound detached regular file only when the full identity remains authorized", async () => {
		const root = await temporaryDirectory();
		const original = path.join(root, "state.jsonl");
		const detached = path.join(root, ".gjc-delete-state");
		await fs.writeFile(original, "authorized");
		const stat = await fs.stat(original, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: path.basename(detached),
			detachOnly: true,
		};

		expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
		expect(exactRestore(detached, original, identity)).toEqual({ ok: true });
		expect(await fs.readFile(original, "utf8")).toBe("authorized");
	});

	it("refuses a Windows exact-restore collision without clobbering either object", async () => {
		const root = await temporaryDirectory();
		const original = path.join(root, "state.jsonl");
		const detached = path.join(root, ".gjc-delete-state");
		await fs.writeFile(original, "authorized");
		const stat = await fs.stat(original, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: path.basename(detached),
			detachOnly: true,
		};

		expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
		await fs.writeFile(original, "replacement");
		expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "collision" });
		expect(await fs.readFile(original, "utf8")).toBe("replacement");
		expect(await fs.readFile(detached, "utf8")).toBe("authorized");
	});

	it("refuses a detached Windows replacement whose digest no longer matches", async () => {
		const root = await temporaryDirectory();
		const original = path.join(root, "state.jsonl");
		const detached = path.join(root, ".gjc-delete-state");
		await fs.writeFile(original, "authorized");
		const stat = await fs.stat(original, { bigint: true });
		const identity = {
			dev: stat.dev,
			ino: stat.ino,
			size: stat.size,
			mtimeNs: stat.mtimeNs,
			sha256: sha256("authorized"),
			quarantineName: path.basename(detached),
			detachOnly: true,
		};

		expect(exactUnlink(original, identity)).toEqual({ ok: true, detachedPath: detached });
		await fs.writeFile(detached, "replacement");
		expect(exactRestore(detached, original, identity)).toEqual({ ok: false, code: "identity_mismatch" });
		expect(await fs.readFile(detached, "utf8")).toBe("replacement");
		expect(
			await fs.stat(original).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("rejects ancestor junction exact deletes without touching their targets", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const junction = path.join(root, "junction");
		const file = path.join(target, "state.json");
		await fs.mkdir(target);
		await fs.writeFile(file, "preserve");
		await fs.symlink(target, junction, "junction");
		const stat = await fs.stat(file, { bigint: true });

		expect(
			exactUnlink(path.join(junction, "state.json"), {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("preserve"),
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(file, "utf8")).toBe("preserve");
	});

	it("rejects an ancestor replaced by a junction after authorization", async () => {
		const root = await temporaryDirectory();
		const parent = path.join(root, "managed");
		const target = path.join(root, "target");
		const file = path.join(parent, "state.jsonl");
		await fs.mkdir(parent);
		await fs.mkdir(target);
		await fs.writeFile(file, "authorized");
		const stat = await fs.stat(file, { bigint: true });
		await fs.rename(parent, path.join(root, "managed-retained"));
		await fs.symlink(target, parent, "junction");

		expect(
			exactUnlink(file, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				sha256: sha256("authorized"),
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(root, "managed-retained", "state.jsonl"), "utf8")).toBe("authorized");
	});

	it("rejects final junction directory detach without touching its target", async () => {
		const root = await temporaryDirectory();
		const target = path.join(root, "target");
		const junction = path.join(root, "junction");
		await fs.mkdir(target);
		await fs.writeFile(path.join(target, "state.json"), "preserve");
		await fs.symlink(target, junction, "junction");
		const stat = await fs.stat(target, { bigint: true });

		expect(
			exactUnlink(junction, {
				dev: stat.dev,
				ino: stat.ino,
				size: stat.size,
				mtimeNs: stat.mtimeNs,
				directory: true,
				quarantineName: ".gjc-delete-preauthorized",
			}),
		).toEqual({ ok: false, code: "reparse_point" });
		expect(await fs.readFile(path.join(target, "state.json"), "utf8")).toBe("preserve");
	});

	it("keeps local case aliases classified as the same volume identity", async () => {
		const root = await temporaryDirectory();
		const mixedCase = path.join(root, "MixedCase");
		await fs.mkdir(mixedCase);

		const direct = canonicalExistingDirectoryIdentity(mixedCase);
		const caseAlias = canonicalExistingDirectoryIdentity(path.join(root, "mixedcase"));
		expect(direct.ok).toBe(true);
		expect(caseAlias).toEqual(direct);
	});

	it("classifies UNC paths as unsupported network identities without probing a share", () => {
		expect(canonicalExistingDirectoryIdentity(String.raw`\\server\share\workspace`)).toEqual({
			ok: false,
			code: "network_unsupported",
		});
	});

	it("classifies extended UNC paths as unsupported network identities without probing a share", () => {
		expect(canonicalExistingDirectoryIdentity(String.raw`\\?\UNC\server\share\workspace`)).toEqual({
			ok: false,
			code: "network_unsupported",
		});
	});

	it.skipIf(!process.env.GJC_TEST_SUBST_WORKSPACE)(
		"resolves a configured subst workspace through the local volume",
		() => {
			const substWorkspace = process.env.GJC_TEST_SUBST_WORKSPACE;
			if (!substWorkspace) throw new Error("Missing subst workspace");

			const resolved = canonicalExistingDirectoryIdentity(substWorkspace);
			expect(resolved.ok).toBe(true);
			if (resolved.ok) expect(resolved.canonicalPath).toStartWith("\\\\?\\Volume{");
		},
	);
});
