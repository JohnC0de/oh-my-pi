import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { Shell } from "@oh-my-pi/pi-natives";
import * as direnvModule from "@oh-my-pi/pi-coding-agent/exec/direnv";
import { StreamRedactor } from "@oh-my-pi/pi-coding-agent/stream/redactor";
import { ToolResultBuilder } from "@oh-my-pi/pi-coding-agent/tools/tool-result";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";

afterEach(() => {
	mock.restore();
});

function makeSession(overrides: Readonly<Record<string, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"astGrep.enabled": false,
			"astEdit.enabled": false,
			"grep.enabled": false,
			"glob.enabled": false,
			...overrides,
		}),
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

describe("BashTool execution results", () => {
	it("retains managed job identity after a foreground job settles", async () => {
		const session = makeSession({ "bash.autoBackground.enabled": true });
		session.asyncJobManager = new AsyncJobManager({ retentionMs: 0 });
		const result = await new BashTool(session).execute("trace-job", { command: "printf managed" });
		expect(result.details?.execution.jobId).toBeString();
		expect(result.details?.execution.executedCommand).toBe("printf managed");
	});

	it("records final dispatch for explicitly requested background jobs", async () => {
		const session = makeSession({ "async.enabled": true });
		const manager = new AsyncJobManager({ retentionMs: 60_000 });
		session.asyncJobManager = manager;
		const updates: unknown[] = [];
		try {
			const result = await new BashTool(session).execute(
				"explicit-background-trace",
				{ command: "printf explicit-background", async: true },
				undefined,
				update => updates.push(update),
			);
			const jobId = result.details?.execution.jobId;
			if (!jobId) throw new Error("Expected the background job identity");
			const job = manager.getJob(jobId);
			if (!job) throw new Error("Expected the registered background job");
			await job.promise;
			expect(updates).toContainEqual(
				expect.objectContaining({
					details: expect.objectContaining({
						execution: expect.objectContaining({
							jobId,
							dispatch: expect.objectContaining({ backend: "embedded", command: "printf explicit-background" }),
						}),
					}),
				}),
			);
		} finally {
			await manager.dispose();
		}
	});

	it("preserves unchanged command output and owner identity in execution metadata", async () => {
		const session = makeSession();
		session.getSessionId = () => "trace-session";
		session.getAgentId = () => "trace-agent";
		const result = await new BashTool(session).execute("trace-call", { command: "printf trace-output" });
		expect(result.details?.execution).toMatchObject({
			requestedCommand: "printf trace-output",
			executedCommand: "printf trace-output",
			rewritten: false,
			ownerSessionId: "trace-session",
			ownerAgentId: "trace-agent",
		});
		expect(result.content.find(item => item.type === "text")?.text).not.toContain("[Command rewritten]");
	});

	it("surfaces the redacted requested and executed rewrite without changing dispatch", async () => {
		const session = makeSession({ "worktree.clone": true });
		const realRun = Shell.prototype.run;
		let dispatched = "";
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			dispatched = options.command;
			return realRun.call(this, { ...options, command: "printf rewritten-output" }, onChunk);
		});
		const command = "git worktree add 'path with spaces' && echo TOKEN=hidden-value";
		const result = await new BashTool(session).execute("trace-rewrite", { command });
		expect(dispatched).toContain("worktree add -- 'path with spaces'");
		expect(dispatched).not.toStartWith("git ");
		expect(result.details?.execution.rewritten).toBe(true);
		expect(result.details?.execution.requestedCommand).toContain("git worktree add");
		expect(result.details?.execution.executedCommand).toContain("worktree add --");
		const text = result.content.find(item => item.type === "text")?.text ?? "";
		expect(text).toContain("[Command rewritten]");
		expect(text).toContain("rewritten-output");
		expect(text).not.toContain("hidden-value");
		expect(JSON.stringify(result.details?.execution)).not.toContain("hidden-value");
	});

	it.each(["'synthetic alpha beta'", '"synthetic alpha beta"'])(
		"keeps quoted secret values out of rewritten output and all execution metadata: %s",
		async value => {
			const command = `cd /tmp && PASSWORD=${value} TOKEN=${value} true`;
			const result = await new BashTool(makeSession()).execute("quoted-trace", { command });
			const rendered = JSON.stringify(result);
			expect(rendered).not.toContain("synthetic");
			expect(rendered).not.toContain("alpha");
			expect(rendered).not.toContain("beta");
			expect(result.details?.execution.requestedCommand).toContain("PASSWORD=••••••");
			expect(result.details?.execution.dispatch?.command).toContain("TOKEN=••••••");
		},
	);

	it.each([
		"$'sy\\x6ethetic-value-123'",
		"$'sy\\156thetic-value-123'",
		"$'sy\\u006ethetic-value-123'",
		"syn$'\\x74he'\"tic-value-123\"",
	])("redacts known ANSI-C encoded arguments in requested and dispatched metadata: %s", async word => {
		const secret = "synthetic-value-123";
		spyOn(StreamRedactor, "load").mockResolvedValue(
			new StreamRedactor([], [{ value: secret, prefix: secret.slice(0, 6) }]),
		);
		const run = spyOn(Shell.prototype, "run");
		const result = await new BashTool(makeSession()).execute("ansi-c-trace", {
			command: `cd /tmp && true ${word}`,
		});
		expect(run.mock.calls[0]?.[0].command).toBe(`true ${word}`);
		expect(result.details?.execution).toMatchObject({
			requestedCommand: "cd /tmp && true ••••••",
			executedCommand: "true ••••••",
			dispatch: { command: "true ••••••" },
		});
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("Executed: true ••••••");
		expect(JSON.stringify(result)).not.toContain(word);
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	it.each([false, true])("loads metadata secrets from effective cwd (leading cd: %s)", async leadingCd => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "trace-cwd-"));
		const synthetic = "effective-cwd-only-value";
		const load = spyOn(StreamRedactor, "load").mockResolvedValue(
			new StreamRedactor([], [{ value: synthetic, prefix: synthetic.slice(0, 6) }]),
		);
		try {
			const command = `true ${synthetic}`;
			const result = await new BashTool(makeSession()).execute(
				"cwd-trace",
				leadingCd ? { command: `cd '${cwd}' && ${command}` } : { command, cwd },
			);
			expect(load).toHaveBeenCalledWith(cwd, []);
			expect(JSON.stringify(result.details?.execution)).not.toContain(synthetic);
			expect(result.details?.execution.dispatch?.cwd).toBe(cwd);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("captures the final embedded dispatch after shell prefix and direnv unsets", async () => {
		const session = makeSession({ "bash.direnv": "auto" });
		const shell = session.settings.getShellConfig();
		spyOn(Settings, "init").mockResolvedValue(session.settings);
		spyOn(Settings.prototype, "getShellConfig").mockReturnValue({ ...shell, prefix: "command" });
		spyOn(direnvModule, "loadDirenvEnv").mockResolvedValue({ set: {}, unset: ["TRACE_REMOVED"] });
		const realRun = Shell.prototype.run;
		let dispatched: { command: string; cwd?: string | null } | undefined;
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			dispatched = options;
			return realRun.call(this, options, onChunk);
		});
		const result = await new BashTool(session).execute("final-trace", { command: "printf final-output" });
		if (!dispatched || dispatched.cwd == null) throw new Error("Expected shell dispatch with an explicit cwd");
		expect(dispatched.command).toBe("unset -v TRACE_REMOVED; command printf final-output");
		expect(result.details?.execution.dispatch).toEqual({
			backend: "embedded",
			command: dispatched.command,
			program: null,
			argv: null,
			cwd: dispatched.cwd,
		});
		expect(result.details?.execution.executedCommand).toBe(dispatched.command);
		expect(result.details?.execution.rewritten).toBe(true);
	});

	it("preserves the first text, secondary texts, and images when adding a rewrite notice", async () => {
		const image = { type: "image" as const, mimeType: "image/png", data: "synthetic-image" };
		const first = { type: "text" as const, text: "first output" };
		const second = { type: "text" as const, text: "secondary output" };
		const content = [image, first, second, image];
		spyOn(ToolResultBuilder.prototype, "done").mockReturnValue({ content, details: {} });
		const result = await new BashTool(makeSession()).execute("preserve-trace", { command: "cd /tmp && true" });
		expect(result.content[0]).toBe(image);
		expect(result.content[1]).toEqual({ type: "text", text: expect.stringContaining("\n\nfirst output") });
		expect(result.content.slice(2)).toEqual([second, image]);
		expect(content).toEqual([image, first, second, image]);
		expect(first.text).toBe("first output");
	});

	it.each([
		{ wallTimeMs: 0, noticeCount: 1 },
		{ wallTimeMs: 1000, noticeCount: 2 },
	])("preserves timing-like stdout in shell views at $wallTimeMs ms", async ({ wallTimeMs, noticeCount }) => {
		let now = 0;
		spyOn(performance, "now").mockImplementation(() => now);
		const realRun = Shell.prototype.run;
		spyOn(Shell.prototype, "run").mockImplementation(async function (this: Shell, options, onChunk) {
			const result = await realRun.call(this, options, onChunk);
			now = wallTimeMs;
			return result;
		});
		const tool = new BashTool(makeSession());
		const args = { command: `printf 'Wall time: %.2f seconds\\n' ${wallTimeMs / 1000}` };
		const result = await tool.execute("call-timing-output", args);
		const timingOutput = `Wall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`;
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(result.details?.wallTimeMs).toBe(wallTimeMs);
		expect(text.match(/Wall time: \d+\.\d{2} seconds/gu)).toHaveLength(noticeCount);
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");

		for (const expanded of [false, true]) {
			const options = { expanded, isPartial: false };
			const component = bashToolRenderer.renderResult(result, options, theme, args);
			const rendered = Bun.stripANSI(component.render(120).join("\n"));
			expect(rendered.match(/Wall time: \d+\.\d{2} seconds/gu)).toEqual([timingOutput]);
			const view = bashToolRenderer.describeResult(result, options, args);
			const output = (view.body ?? [])
				.flatMap(node => ("k" in node ? (node.c ?? []) : []))
				.find(node => "k" in node && node.k === "ansi");
			expect(output).toMatchObject({ p: { role: "omp.tool.bash.output", text: timingOutput } });
		}
	});

	it("resolves with an error result carrying execution details instead of throwing", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-fail", { command: "exit 3" });

		// A completed command that failed is a non-throwing error result so the
		// renderer keeps the wall time / timeout / exit-code footer.
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(3);
		expect(result.details?.timeoutSeconds).toBe(300);
		expect(typeof result.details?.wallTimeMs).toBe("number");

		// The LLM-facing text still states the exit code verbatim.
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Command exited with code 3");
	});

	it("returns a warning-state timeout result with one timeout notice", async () => {
		// Keep the real native subprocess timeout path, but compress its backend
		// deadline; BashTool must still report the user-facing one-second timeout.
		const realRun = Shell.prototype.run;
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			return realRun.call(this, { ...options, timeoutMs: 20 }, onChunk);
		});
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-timeout", { command: "sleep 3", timeout: 1 });

		expect(result.isError).toBe(true);
		expect(result.details?.timedOut).toBe(true);
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text.match(/\[Command timed out after 1 seconds\]/gu)).toHaveLength(1);
	});

	it("preserves the executor cancellation notice without classifying it as a timeout", async () => {
		const dispatched = Promise.withResolvers<void>();
		const realRun = Shell.prototype.run;
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			dispatched.resolve();
			return realRun.call(this, options, onChunk);
		});
		const tool = new BashTool(makeSession());
		const controller = new AbortController();
		const execution = tool.execute("call-cancel", { command: "sleep 3" }, controller.signal);
		await dispatched.promise;
		controller.abort();

		const error = await execution.catch(error => error);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message.match(/\[Command cancelled\]/gu)).toHaveLength(1);
		expect(message).not.toContain("Command aborted");
	});

	it("returns a success result with no exit-code detail for a zero exit", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-ok", { command: "printf hi" });

		expect(result.isError).toBeUndefined();
		expect(result.details?.exitCode).toBeUndefined();
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("hi");
		expect(text).not.toContain("Command exited with code");
	});

	it("keeps the raw diagnostics when a minimized failure cannot be persisted as an artifact", async () => {
		// The native minimizer streams the raw bytes live, then reports a lossy
		// summary. This session has no artifact allocator (the `ToolSession`
		// contract makes it optional), so the original capture has nowhere to go:
		// substituting the summary would silently drop every actionable line.
		const rawOutput =
			"test/event-cache.e2e-spec.ts:281:5 error TS2304 Cannot find name 'foo'\n" +
			"test/event-cache.e2e-spec.ts:300:9 error TS2345 Argument of type 'string' is not assignable\n";
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			onChunk?.(null, rawOutput);
			return Promise.resolve({
				exitCode: 1,
				cancelled: false,
				timedOut: false,
				workingDir: process.cwd(),
				minimized: {
					filter: "lint",
					text: "test/event-cache.e2e-spec.ts:281-405 multiple ... errors\n",
					originalText: rawOutput,
					inputBytes: Buffer.byteLength(rawOutput, "utf-8"),
					outputBytes: 54,
				},
			});
		});

		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-minimized-unpersisted", { command: "pnpm lint" });

		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(1);
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("TS2304 Cannot find name 'foo'");
	});

	it("preserves final-stage output when a pipeline ends in head or tail", async () => {
		const tool = new BashTool(makeSession());

		for (const scenario of [
			{ command: "seq 1 5 | head -n2", expected: "1\n2" },
			{ command: "seq 1 5 | tail -n2", expected: "4\n5" },
		]) {
			const result = await tool.execute(`call-pipeline-${scenario.expected[0]}`, { command: scenario.command });
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			const stdout = text.replace(/\n\nWall time: \d+\.\d{2} seconds$/, "").trimEnd();

			expect(result.isError).toBeUndefined();
			expect(stdout).toBe(scenario.expected);
		}
	});
});

describe("BashTool skill:// working directory", () => {
	async function skillFixture(): Promise<{ dir: string; skillDir: string; skill: Skill }> {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-skill-cwd-")));
		const skillDir = path.join(dir, "skill");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "body\n");
		return {
			dir,
			skillDir,
			skill: {
				name: "docs",
				description: "d",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		};
	}

	it("runs a command with a bare skill URI as cwd, resolving relative paths inside it", async () => {
		const { dir, skill } = await skillFixture();
		try {
			const tool = new BashTool({ ...makeSession(), skills: [skill] });
			const result = await tool.execute("call-skill-cwd", { command: "pwd; cat SKILL.md", cwd: "skill://docs" });
			const text = result.content.find(c => c.type === "text")?.text ?? "";

			expect(result.isError).toBeUndefined();
			expect(text).toContain("skill://docs");
			expect(text).toContain("body");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("runs a leading cd into a bare skill URI", async () => {
		const { dir, skill } = await skillFixture();
		try {
			const tool = new BashTool({ ...makeSession(), skills: [skill] });
			const result = await tool.execute("call-skill-cd", { command: "cd skill://docs && cat SKILL.md" });
			const text = result.content.find(c => c.type === "text")?.text ?? "";

			expect(result.isError).toBeUndefined();
			expect(text).toContain("body");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("BashTool skill:// containment failures", () => {
	async function containedFixture(): Promise<{ dir: string; outsideFile: string; skill: Skill }> {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-skill-contained-")));
		const pluginRoot = path.join(dir, "plugin");
		const skillDir = path.join(pluginRoot, "skills", "docs");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(path.join(skillDir, "SKILL.md"), "body\n");
		const outsideFile = path.join(dir, "secret.md");
		await fs.writeFile(outsideFile, "outside contents\n");
		return {
			dir,
			outsideFile,
			skill: {
				name: "docs",
				description: "d",
				filePath: outsideFile,
				baseDir: skillDir,
				source: "agent-plugins:user",
				containRoot: pluginRoot,
			},
		};
	}

	it("refuses a read through a symlink past the plugin boundary", async () => {
		const { dir, outsideFile, skill } = await containedFixture();
		await fs.symlink(outsideFile, path.join(skill.baseDir, "leak.md"));
		try {
			const tool = new BashTool({ ...makeSession(), skills: [skill] });
			const result = await tool.execute("call-skill-leak", { command: "cat skill://docs/leak.md" });
			const text = result.content.find(c => c.type === "text")?.text ?? "";

			expect(result.isError).toBe(true);
			expect(text).not.toContain("outside contents");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a working directory past the plugin boundary instead of running in it", async () => {
		const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bash-skill-contained-")));
		const pluginRoot = path.join(dir, "plugin");
		await fs.mkdir(pluginRoot, { recursive: true });
		const skill: Skill = {
			name: "docs",
			description: "d",
			filePath: path.join(dir, "SKILL.md"),
			baseDir: dir,
			source: "agent-plugins:user",
			containRoot: pluginRoot,
		};
		try {
			const tool = new BashTool({ ...makeSession(), skills: [skill] });

			await expect(tool.execute("call-skill-leak-cwd", { command: "pwd", cwd: "skill://docs" })).rejects.toThrow(
				"resolves outside the plugin root",
			);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
