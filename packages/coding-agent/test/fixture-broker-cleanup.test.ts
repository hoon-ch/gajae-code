import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
	cleanupFixtureRoot,
	cleanupFixtureRoots,
	createFixtureBrokerEnvironment,
	createFixtureRootCleanup,
	fixtureRootForTest,
	registerFixtureRuntime,
	withFixtureBrokerEnvironment,
} from "./helpers/fixture-broker-cleanup";

const temp = () => fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "gjc-fixture-cleanup-"));

function lease(events: string[], failures = 0) {
	let attempts = 0;
	return {
		async close() {
			events.push("lease");
			attempts++;
			if (attempts <= failures) throw new Error("lease secret=do-not-leak");
		},
	};
}

describe("fixture broker root cleanup", () => {
	it("runs root-wide phases in order and removes its registry only after verified absence", async () => {
		const root = await temp();
		const events: string[] = [];
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), lease(events));
		registerFixtureRuntime(cleanup, {
			key: "a",
			requiredOwner: "runtime",
			shutdown: async () => void events.push("shutdown:a"),
			dispose: async () => void events.push("dispose:a"),
		});
		registerFixtureRuntime(cleanup, {
			key: "b",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => void events.push("shutdown:b"),
			dispose: async () => void events.push("dispose:b"),
		});
		await cleanupFixtureRoot(cleanup, {
			removeRoot: async value => {
				events.push("remove");
				await fs.rm(value, { recursive: true, force: true });
			},
			absenceObservationMs: 0,
			rootExists: async () => {
				events.push("absent");
				return false;
			},
		});
		expect(events).toEqual(["shutdown:a", "shutdown:b", "dispose:a", "dispose:b", "lease", "remove", "absent"]);
		expect(fixtureRootForTest(root)).toBeUndefined();
	});

	it("continues disposal after shutdown failure and retains callbacks and authority for retry", async () => {
		const root = await temp();
		const events: string[] = [];
		let fail = true;
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), lease(events));
		registerFixtureRuntime(cleanup, {
			key: "runtime",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				events.push("shutdown");
				if (fail) throw new Error("shutdown failed");
			},
			dispose: async () => void events.push("dispose"),
		});
		await expect(cleanupFixtureRoot(cleanup)).rejects.toThrow("runtime cleanup failed");
		expect(events).toEqual(["shutdown", "dispose"]);
		expect(cleanup.entries.get("runtime")?.requiredOwner).toBe("runtime-and-broker");
		expect(cleanup.phases.leaseClose).toBe("pending");
		fail = false;
		await cleanupFixtureRoot(cleanup, { rootExists: async () => false });
		expect(events).toEqual(["shutdown", "dispose", "shutdown", "lease"]);
	});

	it("retries a failed lease and root recreation without replaying verified runtime phases", async () => {
		const root = await temp();
		const events: string[] = [];
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), lease(events, 1));
		registerFixtureRuntime(cleanup, {
			key: "runtime",
			requiredOwner: "runtime",
			shutdown: async () => void events.push("shutdown"),
			dispose: async () => void events.push("dispose"),
		});
		await expect(cleanupFixtureRoot(cleanup)).rejects.toThrow("lease close failed");
		expect(cleanup.phases.leaseClose).toBe("pending");
		await expect(cleanupFixtureRoot(cleanup, { rootExists: async () => true })).rejects.toThrow("recreated");
		expect(cleanup.recreation?.detail).toBe("fixture root reappeared");
		expect(cleanup.phases.rootRemove).toBe("pending");
		await cleanupFixtureRoot(cleanup, { rootExists: async () => false });
		expect(events).toEqual(["shutdown", "dispose", "lease", "lease"]);
	});

	it("sanitizes and restores the production SDK opt-out without contacting operator state", async () => {
		const prior = process.env.GJC_SDK_DISABLE;
		process.env.GJC_SDK_DISABLE = "1";
		try {
			await withFixtureBrokerEnvironment(async () => {
				expect(process.env.GJC_SDK_DISABLE).toBeUndefined();
			});
			expect(process.env.GJC_SDK_DISABLE).toBe("1");
		} finally {
			if (prior === undefined) delete process.env.GJC_SDK_DISABLE;
			else process.env.GJC_SDK_DISABLE = prior;
		}
	});

	it("detects recreation during the bounded absence window", async () => {
		const root = await temp();
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), lease([]));
		let probes = 0;
		await expect(
			cleanupFixtureRoot(cleanup, {
				absenceObservationMs: 50,
				absencePollMs: 1,
				rootExists: async () => ++probes >= 2,
			}),
		).rejects.toThrow("recreated");
		expect(probes).toBeGreaterThanOrEqual(2);
		expect(cleanup.phases.leaseClose).toBe("verified");
		expect(cleanup.phases.rootRemove).toBe("pending");
	});

	it("stops bounded absence polling after the configured deadline", async () => {
		const root = await temp();
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), lease([]));
		let probes = 0;
		await cleanupFixtureRoot(cleanup, {
			absenceObservationMs: 15,
			absencePollMs: 1,
			rootExists: async () => {
				probes++;
				return false;
			},
		});
		expect(probes).toBeGreaterThan(1);
		expect(probes).toBeLessThan(100);
	});

	it("serializes concurrent root cleanup into one phase attempt", async () => {
		const root = await temp();
		const events: string[] = [];
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), lease(events));
		registerFixtureRuntime(cleanup, {
			key: "runtime",
			requiredOwner: "runtime-and-broker",
			shutdown: async () => {
				events.push("shutdown");
				await Bun.sleep(10);
			},
			dispose: async () => void events.push("dispose"),
		});
		const first = cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		const second = cleanupFixtureRoot(cleanup, { absenceObservationMs: 0 });
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(events).toEqual(["shutdown", "dispose", "lease"]);
	});

	it("retains pending dispose and root-removal phases independently for retry", async () => {
		const root = await temp();
		const events: string[] = [];
		let disposeFails = true;
		let removeFails = true;
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), lease(events));
		registerFixtureRuntime(cleanup, {
			key: "runtime",
			requiredOwner: "runtime",
			dispose: async () => {
				events.push("dispose");
				if (disposeFails) throw new Error("dispose failed");
			},
		});
		const options = {
			absenceObservationMs: 0,
			removeRoot: async (value: string) => {
				events.push("remove");
				if (removeFails) throw new Error("remove failed");
				await fs.rm(value, { recursive: true, force: true });
			},
		};
		await expect(cleanupFixtureRoot(cleanup, options)).rejects.toThrow("runtime cleanup failed");
		disposeFails = false;
		await expect(cleanupFixtureRoot(cleanup, options)).rejects.toThrow("root removal failed");
		removeFails = false;
		await cleanupFixtureRoot(cleanup, options);
		expect(events).toEqual(["dispose", "dispose", "lease", "remove", "remove"]);
	});

	it("retains failed root records in the caller registry until retry succeeds", async () => {
		const root = await temp();
		const events: string[] = [];
		let fail = true;
		const cleanup = createFixtureRootCleanup(root, path.join(root, "agent"), {
			async close() {
				events.push("lease");
				if (fail) throw new Error("close failed");
			},
		});
		const cleanups = [cleanup];
		await expect(cleanupFixtureRoots(cleanups)).rejects.toThrow("root cleanup failed");
		expect(cleanups).toEqual([cleanup]);
		fail = false;
		await cleanupFixtureRoots(cleanups);
		expect(cleanups).toEqual([]);
		expect(events).toEqual(["lease", "lease"]);
	});

	it("builds an allowlisted fixture child environment without SDK opt-out state", () => {
		const environment = createFixtureBrokerEnvironment("/fixture-root", "/fixture-root/agent");
		expect(environment).toMatchObject({
			HOME: "/fixture-root",
			XDG_CONFIG_HOME: "/fixture-root/config",
			GJC_AGENT_DIR: "/fixture-root/agent",
			GJC_CODING_AGENT_DIR: "/fixture-root/agent",
		});
		expect(environment.GJC_SDK_DISABLE).toBeUndefined();
	});
});
