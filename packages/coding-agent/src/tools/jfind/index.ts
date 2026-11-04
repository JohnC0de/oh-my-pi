/**
 * `find`: semantic grep over the workspace, driven by the session's judge
 * role. The exploration (lexical prior, filename ranking, sketch routing,
 * passage verification) lives in {@link runCascade}; this file is the tool
 * contract and the model-facing report.
 */
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { FindToolDetails } from "@oh-my-pi/pi-tui/tools/find";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { formatBytes, formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { sessionResolveContext } from "../../internal-urls/context";
import { InternalUrlFilesystem } from "../../internal-urls/url-filesystem";
import { hasNativeJudge, journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "../../judgment";
import findDescription from "../../prompts/tools/find.md" with { type: "text" };
import type { ToolSession } from "..";
import { resolveToolTier } from "../approval";
import {
	formatPathRelativeToCwd,
	normalizePathLikeInput,
	resolveSearchResultPath,
	searchPathTier,
} from "../path-utils";
import { searchApprovalCacheTargets } from "../search-approval-targets";
import { toolResult } from "../tool-result";
import { type CascadeResult, runCascade } from "./cascade";
import { rankedHeat } from "./passages";
import { resolveSearchRoot } from "./tree";

import { cfgFindEnabled } from "../settings";

const findSchema = type({
	query: "string",
	grep_keywords: "string[]",
	"path?": "string",
});

export type FindToolInput = typeof findSchema.infer;

/** Line ranges shown per hit in the model-facing text, strongest first. */
const RANGES_SHOWN = 3;

/** Judging budget for one `find` call: past it the call reports what was judged instead of blocking the turn. */
const FIND_TIMEOUT_MS = 20_000;
/** Extra wall time for the cascade to wrap up after the judging budget; past it the call fails. */
const FIND_WRAP_UP_MS = 5_000;
/** Unjudged lead files listed when judging produced no hits and coverage is not complete. */
const LEADS_SHOWN = 8;

/**
 * Resolve `find.enabled` for a session: `auto` enables `find` only when the
 * judge role is backed by a native System One model ({@link hasNativeJudge})
 * rather than a prompted small model. Gates tool creation and the `find` hints
 * in sibling tool prompts.
 */
export function isFindEnabled(session: ToolSession): boolean {
	const mode = cfgFindEnabled.get(session.settings);
	if (mode !== "auto") return mode === "on";
	return session.modelRegistry !== undefined && hasNativeJudge(session.settings, session.modelRegistry);
}

/** Semantic search tool: describe a behavior, get files and line ranges that implement it. */
export class FindTool implements AgentTool<typeof findSchema, FindToolDetails> {
	readonly name = "find";
	readonly approval = searchPathTier;
	/** `always-ask-cached` keys: the tree (or file) it searches, as `grep` reports one. */
	readonly approvalCacheTargets = (args: unknown): readonly string[] | undefined => {
		const root = (args as { path?: string } | null | undefined)?.path;
		return searchApprovalCacheTargets(root ? [root] : [], this.session.cwd, entry => entry);
	};
	readonly loadMode = "essential";
	readonly label = "Find";
	readonly summary = "Semantic grep: find files and line ranges by describing what they do";
	readonly description = findDescription;
	readonly parameters = findSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(
		_toolCallId: string,
		params: FindToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<FindToolDetails>,
	): Promise<AgentToolResult<FindToolDetails>> {
		const query = params.query.trim();
		if (query.length === 0) throw new ToolError("`query` must be a non-empty description");
		const cwd = this.session.cwd;
		const rawScopeInput = params.path === undefined ? "" : normalizePathLikeInput(params.path);
		// Host paths stay native; internal URLs (`local://`, `omp://`, …) are
		// listed, scanned, and read in place through the URL filesystem.
		const filesystem = new InternalUrlFilesystem({
			context: sessionResolveContext(this.session, { signal, containSkillPaths: true }),
			tier: resolveToolTier(this, params),
		});
		const root = await resolveSearchRoot(filesystem, rawScopeInput, cwd);
		const scopePath =
			root.path === path.resolve(cwd)
				? undefined
				: formatPathRelativeToCwd(root.path, cwd, { trailingSlash: root.type === "directory" });
		const registry = this.session.modelRegistry;
		if (!registry) throw new ToolError("find has no model registry to resolve a judge from");
		const judge = resolveJudge({
			settings: this.session.settings,
			registry,
			sessionId: this.session.getSessionId?.() ?? undefined,
			purpose: "find",
			onUsage: journalJudgmentUsage(this.session.sessionManager),
			telemetry: this.session.getTelemetry?.(),
			cache: sharedJudgmentCache(),
			costGate: this.session.costGate,
		});
		const started = performance.now();
		const deadline = AbortSignal.timeout(FIND_TIMEOUT_MS);
		const hardStop = AbortSignal.timeout(FIND_TIMEOUT_MS + FIND_WRAP_UP_MS);
		let result: CascadeResult;
		try {
			result = await runCascade({
				root,
				filesystem,
				query,
				extraKeywords: params.grep_keywords,
				judge,
				includeHidden: false,
				signal: signal ? AbortSignal.any([signal, hardStop]) : hardStop,
				deadline,
				onProgress: message => onUpdate?.({ content: [{ type: "text", text: message }] }),
			});
		} catch (error) {
			if (deadline.aborted && !signal?.aborted) {
				throw new ToolError(
					`find timed out after ${formatDuration(FIND_TIMEOUT_MS)} before the lexical scan finished; use grep`,
				);
			}
			throw error;
		}
		const elapsedMs = performance.now() - started;
		const { stats, threshold, keywords, coverage, stopped } = result;
		// Cascade paths are root-relative; the model and renderer want paths
		// `read` resolves (cwd-relative files, URLs under URL scopes, including
		// with `:start-end` selectors) without knowing the scope.
		const hits = result.hits.map(hit => ({
			...hit,
			rel: formatPathRelativeToCwd(resolveSearchResultPath(root.path, hit.rel), cwd),
		}));
		const details: FindToolDetails = {
			query,
			keywords,
			threshold,
			hits,
			coverage,
			stats,
			elapsedMs,
			cwd,
			scopePath,
		};
		const where = scopePath === undefined ? "" : ` in ${scopePath}`;
		const out: string[] = [];
		const budget = formatDuration(FIND_TIMEOUT_MS);
		if (coverage === "unavailable") {
			out.push(
				stopped
					? `find unavailable for "${query}"${where}: the judge answered nothing within the ${budget} budget. This is not evidence of absence; read the leads below or use grep.`
					: `find unavailable for "${query}"${where}: all ${stats.requests} judge requests failed, nothing was judged. This is not evidence of absence; read the leads below or use grep.`,
			);
		} else if (hits.length === 0) {
			out.push(`no hits for "${query}"${where} (τ ${threshold.toFixed(2)})`);
		} else {
			out.push(`${hits.length} hit(s) for "${query}"${where} (τ ${threshold.toFixed(2)}), strongest first`);
		}
		if (coverage === "partial") {
			out.push(
				stopped
					? `partial: judging stopped at the ${budget} budget; unjudged files may still match`
					: `partial: ${stats.failed} of ${stats.requests} judge requests failed; unjudged files may still match`,
			);
		}
		if (coverage !== "complete" && hits.length === 0 && result.leads.length > 0) {
			out.push(
				"",
				"leads (unjudged; strongest keyword and filename evidence first):",
				...result.leads
					.slice(0, LEADS_SHOWN)
					.map(rel => `  ${formatPathRelativeToCwd(resolveSearchResultPath(root.path, rel), cwd)}`),
			);
		}
		if (hits.length > 0) out.push("");
		for (const hit of hits) {
			const seen = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
			out.push(`${hit.rel}  ${hit.contentScore.toFixed(2)}  ${seen}`);
			for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
				const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
				out.push(`  ${hit.rel}:${span}  ${range.p.toFixed(2)}  ${range.snippet}`);
			}
		}
		const unanswered = stats.unanswered > 0 ? ` · ${stats.unanswered} unanswered` : "";
		out.push(
			"",
			`listed ${stats.listed} · judged ${stats.judged} · read ${stats.filesRead} files (${formatBytes(stats.fileBytes)}) · ${stats.requests} requests${unanswered} · ${formatNumber(stats.inputTokens)} tokens · $${stats.cost.toFixed(4)} · ${formatDuration(elapsedMs)} wall / ${formatDuration(stats.apiMs)} api`,
		);
		if (stats.failures.length > 0) out.push("failures:", ...stats.failures.map(failure => `  ${failure}`));
		const builder = toolResult(details).text(out.join("\n"));
		if (coverage === "unavailable") builder.error();
		else if (hits.length === 0) builder.useless();
		return builder.done();
	}
}
