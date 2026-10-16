import { describe, expect, it } from "bun:test";
import { formatWorktreeCloneStats } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";

const stats = {
	totalMs: 12.25,
	policyMs: 1.5,
	reconcileMs: 3.75,
	traversalMeasured: true,
	entriesVisited: 20,
	directoriesCreated: 2,
	filesCopied: 10,
	bytesCopied: 1024,
	symlinksCopied: 1,
	entriesSkipped: 7,
};

describe("worktree native clone statistics", () => {
	it("shows measured phase timings and actual traversal counters", () => {
		expect(formatWorktreeCloneStats(stats)).toBe(
			"Clone timing: policy=1.50ms clone=12.25ms reconcile=3.75ms; visited=20 directories=2 files=10 bytes=1024 symlinks=1 skipped=7",
		);
	});

	it("does not present bulk backend counters as measured zeroes", () => {
		const output = formatWorktreeCloneStats({ ...stats, traversalMeasured: false, filesCopied: 0, bytesCopied: 0 });
		expect(output).toContain("traversal counters unavailable for bulk backend");
		expect(output).not.toContain("files=");
		expect(output).not.toContain("bytes=");
	});
});
