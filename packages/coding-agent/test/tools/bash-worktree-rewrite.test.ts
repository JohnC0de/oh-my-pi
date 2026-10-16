import { describe, expect, it } from "bun:test";
import { rewriteGitWorktreeAdd } from "@oh-my-pi/pi-coding-agent/tools/bash-worktree-rewrite";

const OMP = ["bun", "/opt/omp cli.ts"] as const;

describe("rewriteGitWorktreeAdd", () => {
	it("routes supported branch creation through omp with an option terminator", () => {
		expect(rewriteGitWorktreeAdd("git worktree add -b feat ../wt origin/main", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add -b feat -- ../wt origin/main",
		);
	});

	it("preserves surrounding shell structure while rewriting a -C segment", () => {
		expect(rewriteGitWorktreeAdd("cd x && git -C repo worktree add ../wt && ls", OMP)).toBe(
			"cd x && bun '/opt/omp cli.ts' worktree add -C repo -- ../wt && ls",
		);
	});

	it("leaves unsupported or unsafe commands unchanged", () => {
		const commands = [
			"git worktree add --lock ../wt",
			'git worktree add "$HOME/wt"',
			"FOO=1 git worktree add ../wt",
			"git worktree list",
			"printf x | git worktree add ../wt",
			"git worktree add ../wt | cat",
		];
		for (const command of commands) expect(rewriteGitWorktreeAdd(command, OMP)).toBe(command);
	});

	it("quotes rewritten argv containing spaces", () => {
		expect(rewriteGitWorktreeAdd("git worktree add 'path with spaces'", OMP)).toBe(
			"bun '/opt/omp cli.ts' worktree add -- 'path with spaces'",
		);
	});

	it("preserves separators and quoted apostrophes across multiple rewrites", () => {
		expect(rewriteGitWorktreeAdd(`git worktree add "it's here"; git status && git worktree add ../other`, OMP)).toBe(
			`bun '/opt/omp cli.ts' worktree add -- 'it'\\''s here'; git status && bun '/opt/omp cli.ts' worktree add -- ../other`,
		);
	});

	it("does not replace ordinary executables or git text in arguments", () => {
		for (const command of ["omp --harness gate", "printf 'git worktree add ../wt'", "git status && echo done"]) {
			expect(rewriteGitWorktreeAdd(command, OMP)).toBe(command);
		}
	});
});
