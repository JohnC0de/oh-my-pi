import { BashInteractiveOverlayComponent } from "@oh-my-pi/pi-tui/tools/bash-interactive";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type PtyRunResult, PtySession } from "@oh-my-pi/pi-natives";
import { loadXtermTerminal } from "@oh-my-pi/pi-tui/tools/terminal-output";
import { Settings } from "../config/settings";
import { OutputSink, type OutputSummary } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { TerminalGraphicsDecoder } from "../utils/terminal-graphics";
import { type JobMemoryFailure, monitorJobMemory } from "../exec/job-memory";
import { cfgBashMemoryLimitMb } from "../exec/settings";
import { resolveOutputMaxColumns, resolveOutputSinkArtifactMaxBytes, resolveOutputSinkHeadBytes } from "./output-meta";

export interface BashInteractiveResult extends OutputSummary {
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
	memoryLimitExceeded?: boolean;
	/** Terminal graphics extracted from raw PTY output before transcript sanitization. */
	images?: ImageContent[];
}

export async function runInteractiveBashPty(
	ui: Pick<NonNullable<AgentToolContext["ui"]>, "custom">,
	options: {
		command: string;
		cwd: string;
		timeoutMs?: number;
		signal?: AbortSignal;
		env?: Record<string, string>;
		artifactPath?: string;
		artifactId?: string;
	},
): Promise<BashInteractiveResult> {
	const settings = await Settings.init();
	let stopMonitoring: (() => Promise<void>) | undefined;
	// Load the xterm Terminal ctor here (async boundary) — the ui.custom factory below is sync.
	const XtermTerminal = await loadXtermTerminal();
	const { shell: resolvedShell, env: shellEnv } = settings.getShellConfig();
	// The native PTY starts from the process's C environ, which Bun's
	// `process.env` writes never reach, so it is handed the spawn env. A pty call
	// has a user at the keyboard, so it gets the spawn env minus its
	// non-interactive guards (GIT_EDITOR, GPG_TTY, CI; added by procmgr's
	// `buildSpawnEnv`, and a guard added there belongs here too) and NO_COLOR, a
	// monochrome marker. A key left out keeps the inherited launch value.
	const { GIT_EDITOR: _gitEditor, GPG_TTY: _gpgTty, CI: _ci, NO_COLOR: _noColor, ...interactiveShellEnv } = shellEnv;
	const graphics = new TerminalGraphicsDecoder();
	const sink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		headBytes: resolveOutputSinkHeadBytes(settings),
		artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(settings),
		maxColumns: resolveOutputMaxColumns(settings),
	});
	try {
		const result = await ui.custom<BashInteractiveResult>(
			(tui, uiTheme, _keybindings, done) => {
				const session = new PtySession();
				let pid: number | undefined;
				let memoryFailure: JobMemoryFailure | undefined;
				stopMonitoring = monitorJobMemory(
					() => (pid === undefined ? [] : [pid]),
					cfgBashMemoryLimitMb.get(settings),
					failure => {
						memoryFailure = failure;
						session.kill();
					},
				);
				const component = new BashInteractiveOverlayComponent(
					options.command,
					uiTheme,
					() => tui.terminal.rows,
					XtermTerminal,
					{ resize: (columns, rows) => session.resize(columns, rows) },
				);
				let finished = false;
				const finalize = (run: PtyRunResult) => {
					if (finished) return;
					finished = true;
					component.setComplete({ exitCode: run.exitCode, cancelled: run.cancelled, timedOut: run.timedOut });
					tui.requestRender();
					void (async () => {
						await component.flushOutput();
						await stopMonitoring?.();
						const tail = graphics.finish();
						if (tail) sink.push(tail);
						const [summary, images] = await Promise.all([sink.dump(memoryFailure?.message), graphics.images()]);
						done({
							exitCode: run.exitCode,
							cancelled: run.cancelled,
							timedOut: run.timedOut,
							...(memoryFailure ? { cancelled: true, memoryLimitExceeded: true } : {}),
							...summary,
							...(images.length > 0 ? { images } : {}),
						});
					})();
				};
				const cols = Math.max(20, tui.terminal.columns - 2);
				const rows = Math.max(5, tui.terminal.rows - 4);
				component.setHandlers(
					data => {
						try {
							session.write(data);
						} catch {
							// ignore writes after command exits
						}
					},
					() => {
						try {
							session.kill();
						} catch {
							// ignore
						}
					},
					() => {
						try {
							session.kill();
						} catch {
							// ignore
						}
					},
				);
				void session
					.start(
						{
							command: options.command,
							cwd: options.cwd,
							timeoutMs: options.timeoutMs,
							// A real TERM so editors, pagers, and TUIs behave like a normal
							// terminal; direnv's values win over everything.
							env: { ...interactiveShellEnv, TERM: "xterm-256color", ...options.env },
							signal: options.signal,
							cols,
							rows,
							shell: resolvedShell,
						},
						(err, chunk) => {
							if (finished || err || !chunk) return;
							component.appendOutput(chunk);
							const clean = graphics.push(chunk);
							if (clean) sink.push(clean.replace(/\r\n?/gu, "\n"));
							tui.requestRender();
						},
						(error, startedPid) => {
							if (!error) pid = startedPid;
						},
					)
					.then(finalize)
					.catch(error => {
						sink.push(`PTY error: ${error instanceof Error ? error.message : String(error)}\n`);
						finalize({ exitCode: undefined, cancelled: false, timedOut: false });
					});
				return component;
			},
			{ overlay: true },
		);
		return result;
	} finally {
		await stopMonitoring?.();
		await sink.dispose();
	}
}
