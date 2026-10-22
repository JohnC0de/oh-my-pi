import { expect, test } from "bun:test";
import { Process } from "@oh-my-pi/pi-natives";
import { monitorJobMemory, type JobMemoryFailure } from "../src/exec/job-memory";

test.skipIf(process.platform !== "linux")(
	"memory supervision kills an over-limit descendant without stopping sibling jobs",
	async () => {
		const sibling = Bun.spawn(["sleep", "10"], { stdout: "ignore", stderr: "ignore" });
		const child = Bun.spawn(
			["sh", "-c", "python3 -c 'import time; data=bytearray(96*1024*1024); time.sleep(10)' & wait"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		const failure = Promise.withResolvers<JobMemoryFailure>();
		const stop = monitorJobMemory(
			() => [child.pid],
			64,
			result => {
				failure.resolve(result);
				Process.fromPid(child.pid)?.killTree();
			},
		);
		// Real /proc sampling and subprocess allocation cannot use fake timers;
		// this deadline bounds failure only, while success awaits the monitor event.
		const deadline = setTimeout(() => failure.reject(new Error("memory supervision failed to stop the job")), 5000);
		try {
			const result = await failure.promise;
			expect(result.observedBytes).toBeGreaterThan(result.limitBytes);
			expect(result.message).toContain("memory limit exceeded");
			await child.exited;
			expect(sibling.exitCode).toBeNull();
		} finally {
			clearTimeout(deadline);
			await stop();
			Process.fromPid(child.pid)?.killTree();
			sibling.kill();
			await Promise.all([child.exited, sibling.exited]);
		}
	},
	10000,
);
