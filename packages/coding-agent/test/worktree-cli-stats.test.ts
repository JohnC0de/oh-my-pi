import { describe, expect, it } from "bun:test";
import { formatWorktreeCloneStats, formatWorktreeManifestSummary } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";

const stats = {
	totalMs: 12.25,
	policyMs: 1.5,
	reconcileMs: 3.75,
	traversalMs: 2,
	copyMs: 4,
	registerMs: 1,
	branchMs: 0.5,
	checkoutMs: 0,
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
			"Clone timing: policy=1.50ms clone=12.25ms traversal=2.00ms copy=4.00ms register=1.00ms branch=0.50ms reconcile=3.75ms checkout=0.00ms; visited=20 directories=2 files=10 bytes=1024 symlinks=1 skipped=7",
		);
	});

	it("shows bulk payload totals without claiming backend traversal was measured", () => {
		const output = formatWorktreeCloneStats({ ...stats, traversalMeasured: false });
		expect(output).toContain("backend traversal unmeasured");
		expect(output).toContain("manifest files=10 bytes=1024");
	});

	it("summarizes payloads without dumping paths or inventing pruned byte totals", () => {
		const output = formatWorktreeManifestSummary({
			copied: [{ path: "private-name", files: 2, bytes: 12, countsMeasured: true }],
			excluded: [{ path: "cache", files: 0, bytes: 0, countsMeasured: false }],
		});
		expect(output).toContain("files=2 bytes=12");
		expect(output).toContain("1 unmeasured");
		expect(output).toContain("--json");
		expect(output).not.toContain("private-name");
	});
});
