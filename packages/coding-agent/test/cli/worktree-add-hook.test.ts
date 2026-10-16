import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

describe.skipIf(process.platform === "win32")("worktree add checkout hooks", () => {
	let root: string;
	let repo: string;
	let hooks: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-hook-"));
		repo = path.join(root, "repo");
		await $`git init -q ${repo}`.quiet();
		await $`git -C ${repo} -c user.name=Probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit --allow-empty -qm probe`.quiet();
		hooks = path.join(repo, ".git", "hooks");
		await $`git -C ${repo} config core.hooksPath ${hooks}`.quiet();
		await Bun.write(path.join(repo, "local-probe.txt"), "untracked file to exercise clone fallback\n");
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function hook(script: string): Promise<void> {
		const file = path.join(hooks, "post-checkout");
		await Bun.write(file, `#!/bin/sh\n${script}\n`);
		await fs.chmod(file, 0o755);
	}

	async function add(name: string) {
		const worktree = path.join(root, name);
		const result = await $`bun ${cli} worktree add --detach ${worktree} HEAD`.cwd(repo).quiet().nothrow();
		return { worktree, result };
	}

	for (const symlinked of [false, true]) {
		for (const force of [false, true]) {
			it(`rejects ${symlinked ? "symlinked" : "direct"} overlap before ${force ? "moving" : "creating"} a branch`, async () => {
				const branch = "overlap-probe";
				const original = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
				if (force) {
					await $`git -C ${repo} branch ${branch}`.quiet();
					await $`git -C ${repo} -c user.name=Probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit --allow-empty -qm second`.quiet();
				}
				const base = symlinked ? path.join(root, "alias") : repo;
				if (symlinked) await fs.symlink(repo, base, "dir");
				const destination = path.join(base, "nested", "child");
				const result = await $`bun ${cli} worktree add ${force ? "-B" : "-b"} ${branch} ${destination} HEAD`
					.cwd(repo)
					.quiet()
					.nothrow();
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr.toString()).toContain("overlap");
				expect(await Bun.file(path.join(repo, "local-probe.txt")).text()).toBe(
					"untracked file to exercise clone fallback\n",
				);
				expect(await fs.stat(path.join(repo, "nested")).catch(() => null)).toBeNull();
				const ref = await $`git -C ${repo} rev-parse --verify refs/heads/${branch}`.quiet().nothrow();
				if (force) {
					expect(ref.exitCode).toBe(0);
					expect(ref.stdout.toString().trim()).toBe(original);
				} else {
					expect(ref.exitCode).not.toBe(0);
				}
			});
		}
	}

	it("runs post-checkout in the new worktree after clone or plain-checkout fallback", async () => {
		await hook('printf "%s\\n" "$PWD" "$1" "$2" "$3" > .post-checkout-ran; echo hook-output');
		const { worktree, result } = await add("linked");
		const head = (await $`git -C ${repo} rev-parse HEAD`.text()).trim();
		const marker = (await Bun.file(path.join(worktree, ".post-checkout-ran")).text()).trim().split("\n");

		expect(result.exitCode).toBe(0);
		expect(marker).toEqual([worktree, "0".repeat(head.length), head, "1"]);
		expect(result.stderr.toString()).toContain("hook-output");
	});

	it("preserves a refusing hook's failure status and stderr", async () => {
		await hook("echo checkout-refused >&2; exit 17");
		const { result } = await add("refused");

		expect(result.exitCode).toBe(17);
		expect(result.stderr.toString()).toContain("checkout-refused");
	});
});
