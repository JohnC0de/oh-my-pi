import {
	BACKSLASH,
	COLON,
	COMMA,
	isHexDigit,
	isNumberStart,
	isWhitespace,
	JsonLexer,
	LBRACE,
	LBRACKET,
	QUOTE,
	RBRACE,
	RBRACKET,
	SQUOTE,
	VALID_ESCAPE_CHAR,
} from "./json-lexer";

const U = 0x75;

const CONTROL_ESCAPES: readonly string[] = (() => {
	const e: string[] = [];
	e[0x08] = "\\b";
	e[0x09] = "\\t";
	e[0x0a] = "\\n";
	e[0x0c] = "\\f";
	e[0x0d] = "\\r";
	for (let cp = 0; cp <= 0x1f; cp++) {
		e[cp] ??= `\\u${cp.toString(16).padStart(4, "0")}`;
	}
	return e;
})();

/**
 * Sentinel returned by partial-mode value parsing when an atomic value
 * (number / keyword) is incomplete at the streaming edge, so the enclosing
 * object/array rolls back to the last valid prefix instead of committing junk.
 */
const INCOMPLETE = Symbol("incomplete");

/**
 * Lightweight string-level repair of the escape/control-char hazards that make
 * otherwise-valid JSON fail `JSON.parse`: raw control characters inside strings
 * are escaped, and invalid `\x` escapes have their backslash escaped. Returns the
 * input unchanged when no repair is needed. Pure string→string; does not parse.
 */
export function repairJson(json: string): string {
	const len = json.length;
	const parts: string[] = [];
	let lastEmit = 0;
	let inString = false;
	let i = 0;

	while (i < len) {
		if (!inString) {
			// Fast scan: skip to next quote.
			while (i < len && json.charCodeAt(i) !== QUOTE) i++;
			if (i >= len) break;
			inString = true;
			i++;
			continue;
		}

		// Fast scan inside string: advance past chars that need no handling.
		while (i < len) {
			const cp = json.charCodeAt(i);
			if (cp < 0x20 || cp === QUOTE || cp === BACKSLASH) break;
			i++;
		}
		if (i >= len) break;

		const cp = json.charCodeAt(i);

		if (cp === QUOTE) {
			inString = false;
			i++;
			continue;
		}

		if (cp === BACKSLASH) {
			// Need at least one char after the backslash; treat EOI as invalid escape.
			if (i + 1 >= len) {
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			const nextCp = json.charCodeAt(i + 1);

			if (nextCp === U) {
				// Need full \uXXXX, all four digits, all hex.
				if (
					i + 5 < len &&
					isHexDigit(json.charCodeAt(i + 2)) &&
					isHexDigit(json.charCodeAt(i + 3)) &&
					isHexDigit(json.charCodeAt(i + 4)) &&
					isHexDigit(json.charCodeAt(i + 5))
				) {
					i += 6;
					continue;
				}
				// Truncated or non-hex \u — escape the backslash, re-process the rest.
				parts.push(json.slice(lastEmit, i), "\\\\");
				lastEmit = i + 1;
				i++;
				continue;
			}

			if (nextCp < 128 && VALID_ESCAPE_CHAR[nextCp] === 1) {
				i += 2;
				continue;
			}

			parts.push(json.slice(lastEmit, i), "\\\\");
			lastEmit = i + 1;
			i++;
			continue;
		}

		// Control character (cp < 0x20).
		parts.push(json.slice(lastEmit, i), CONTROL_ESCAPES[cp]);
		lastEmit = i + 1;
		i++;
	}

	if (!parts.length) return json;
	if (lastEmit < len) parts.push(json.slice(lastEmit));
	return parts.join("");
}

/**
 * Recursive-descent tree builder over the tolerant {@link JsonLexer} grammar
 * (single quotes, unquoted keys, comments, Python literals, stray commas,
 * literal invalid escapes, apostrophe recovery, bareword values).
 *
 * In `partial` mode (lexer mode `streaming`) an unterminated string/object/array
 * (or a value cut off at end-of-input) is auto-closed with whatever was parsed
 * so far, and an incomplete trailing atom rolls the enclosing container back
 * to its last valid prefix. In strict mode, end-of-input mid-value and trailing
 * garbage both throw, so a final parse never silently accepts a half-formed
 * tool call.
 */
class RelaxedJson {
	readonly #lex: JsonLexer;
	readonly #partial: boolean;

	constructor(source: string, partial: boolean) {
		this.#lex = new JsonLexer(source, partial ? "streaming" : "strict");
		this.#partial = partial;
	}

	parse(): unknown {
		const lex = this.#lex;
		lex.ws();
		if (lex.atEnd) {
			if (this.#partial) return undefined;
			throw new SyntaxError("Unexpected end of JSON input");
		}
		const value = this.#value(false);
		if (value === INCOMPLETE) return undefined;
		lex.ws();
		if (!this.#partial && !lex.atEnd) {
			throw new SyntaxError(`Unexpected trailing characters at position ${lex.pos}`);
		}
		return value;
	}

	#value(allowBareword: boolean): unknown {
		const lex = this.#lex;
		const c = lex.peek();
		if (c === LBRACE) return this.#object();
		if (c === LBRACKET) return this.#array();
		if (c === QUOTE || c === SQUOTE) return lex.string(c).value;
		// JS-only NaN / Infinity are deliberately not accepted: a tool must not
		// execute with a non-finite numeric arg; they fail the lexer's finite
		// guard (strict throw / partial rollback) like other bad tokens.
		if (isNumberStart(c)) return lex.number() ?? INCOMPLETE;
		const keyword = lex.keyword();
		if (keyword !== undefined) return keyword;
		if (this.#partial) {
			// Incomplete / unrecognized atomic token at the streaming edge — signal the
			// caller to roll back to the last valid prefix instead of committing junk.
			lex.pos = lex.src.length;
			return INCOMPLETE;
		}
		if (allowBareword) return lex.bareword();
		throw new SyntaxError(`Unexpected token at position ${lex.pos}`);
	}

	#object(): Record<string, unknown> {
		const lex = this.#lex;
		lex.pos++; // consume {
		const out: Record<string, unknown> = {};
		for (;;) {
			lex.ws();
			if (lex.atEnd) {
				if (this.#partial) return out;
				throw new SyntaxError("Unterminated object");
			}
			const c = lex.peek();
			if (c === RBRACE) {
				lex.pos++;
				return out;
			}
			if (c === COMMA) {
				// Tolerate leading / doubled / trailing commas.
				lex.pos++;
				continue;
			}
			const key = this.#key();
			lex.ws();
			if (lex.peek() === COLON) {
				lex.pos++;
			} else if (this.#partial) {
				return out;
			} else {
				throw new SyntaxError("Expected ':' in object");
			}
			lex.ws();
			if (lex.atEnd) {
				if (this.#partial) return out;
				throw new SyntaxError("Expected value after ':'");
			}
			const value = this.#value(true);
			if (value === INCOMPLETE) return out;
			out[key] = value;
			lex.ws();
			const d = lex.peek();
			if (d === COMMA) {
				lex.pos++;
				continue;
			}
			if (d === RBRACE) {
				lex.pos++;
				return out;
			}
			if (this.#partial) return out;
			throw new SyntaxError("Expected ',' or '}' in object");
		}
	}

	#array(): unknown[] {
		const lex = this.#lex;
		lex.pos++; // consume [
		const out: unknown[] = [];
		for (;;) {
			lex.ws();
			if (lex.atEnd) {
				if (this.#partial) return out;
				throw new SyntaxError("Unterminated array");
			}
			const c = lex.peek();
			if (c === RBRACKET) {
				lex.pos++;
				return out;
			}
			if (c === COMMA) {
				lex.pos++;
				continue;
			}
			const value = this.#value(true);
			if (value === INCOMPLETE) return out;
			out.push(value);
			lex.ws();
			const d = lex.peek();
			if (d === COMMA) {
				lex.pos++;
				continue;
			}
			if (d === RBRACKET) {
				lex.pos++;
				return out;
			}
			if (this.#partial) return out;
			throw new SyntaxError("Expected ',' or ']' in array");
		}
	}

	#key(): string {
		const lex = this.#lex;
		const c = lex.peek();
		if (c === QUOTE || c === SQUOTE) return lex.string(c).value;
		const key = lex.unquotedKey();
		if (key.length === 0 && !this.#partial) throw new SyntaxError("Expected object key");
		return key;
	}
}

/**
 * Final-parse a JSON value, repairing the common LLM malformations
 * ({@link RelaxedJson}). Tries strict `JSON.parse` first (fast path, exact JSON
 * semantics), then the relaxed parser. Throws when the input is unrepairable,
 * truncated, or carries trailing garbage — so callers can skip a bad tool call
 * rather than execute a half-formed one.
 */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch {
		return new RelaxedJson(json, false).parse() as T;
	}
}

/**
 * Parse possibly-incomplete JSON during streaming. Always returns a value, never
 * throws: `{}` for empty/whitespace/unrecoverable buffers, and an auto-closed
 * best-effort object for truncated ones.
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	const trimmed = partialJson?.trimStart();
	if (!trimmed) return {} as T;
	// A container can only be strict JSON once its closer arrived; skip the
	// doomed full-buffer JSON.parse (and its SyntaxError) while it streams.
	const first = trimmed.charCodeAt(0);
	if ((first !== 0x7b && first !== 0x5b) || canCloseContainer(trimmed)) {
		try {
			return JSON.parse(trimmed) as T;
		} catch {}
	}
	try {
		return (new RelaxedJson(trimmed, true).parse() ?? {}) as T;
	} catch {
		return {} as T;
	}
}

/** True when the last non-whitespace character is `}` or `]`. */
function canCloseContainer(text: string): boolean {
	for (let i = text.length - 1; i >= 0; i--) {
		const code = text.charCodeAt(i);
		// JSON whitespace: space, \t, \n, \r
		if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
		return code === 0x7d || code === 0x5d;
	}
	return false;
}

/**
 * Default minimum byte growth before `parseStreamingJsonThrottled` will
 * re-parse a streaming tool-call argument buffer. Acts as the floor of the
 * geometric gate — see {@link parseStreamingJsonThrottled}.
 */
export const STREAMING_JSON_PARSE_MIN_GROWTH = 256;

/**
 * Throttled variant of {@link parseStreamingJson} for the per-delta hot path.
 *
 * Tool calls arrive as a long sequence of small deltas — calling
 * `parseStreamingJson(buffer)` on every delta re-parses the entire buffer
 * each time, giving O(N²) work in the total buffer length. A fixed re-parse
 * floor alone does NOT fix this: with `minGrowthBytes` constant, a buffer of
 * length N is parsed N/minGrowthBytes times at an average cost of N/2, which
 * is still O(N²) (the constant just shrinks). Long `write` payloads — where
 * the buffer is the whole file — made this the dominant main-thread stall
 * during streaming.
 *
 * Instead the gate scales geometrically: once the buffer is large, a re-parse
 * requires growth proportional to the current length (`len / 32`, floored at
 * `minGrowthBytes`). Parse points then form a geometric progression, so a
 * buffer of length N is parsed O(log N) times for O(N log N) total work,
 * while small buffers keep the snappy fixed-cadence updates.
 *
 * Each provider tracks the last parsed length on its tool-call block, so the
 * final `toolcall_end` parse (which providers already perform unconditionally)
 * is the authoritative full parse — the throttle only delays mid-stream UI
 * updates, by at most ~3% of the accumulated content for large buffers.
 *
 * @returns the parsed object plus the new `parsedLen` to persist; or `null`
 *          when the buffer has not grown enough to warrant a re-parse.
 */
export function parseStreamingJsonThrottled<T = Record<string, unknown>>(
	partialJson: string | undefined,
	lastParsedLen: number,
	minGrowthBytes: number = STREAMING_JSON_PARSE_MIN_GROWTH,
): { value: T; parsedLen: number } | null {
	const len = partialJson?.length ?? 0;
	if (len === 0) return null;
	const growth = Math.max(minGrowthBytes, len >> 5);
	if (lastParsedLen > 0 && len - lastParsedLen < growth) return null;
	return { value: parseStreamingJson<T>(partialJson), parsedLen: len };
}

/**
 * Classification of a streaming buffer against strict JSON (RFC 8259):
 * - `"complete"`: exactly one whole JSON value (plus surrounding whitespace).
 * - `"prefix"`: a proper prefix of some valid JSON value — more bytes can
 *   still complete it.
 * - `"invalid"`: no suffix can ever make it valid strict JSON (e.g. a raw
 *   control character inside a string, or a second top-level value).
 */
export type JsonPrefixState = "complete" | "prefix" | "invalid";

/** What the strict-prefix scanner expects at the current position. */
const enum JsonExpect {
	Value,
	ObjKeyOrEnd,
	ObjKey,
	ObjColon,
	ObjCommaOrEnd,
	ArrValueOrEnd,
	ArrCommaOrEnd,
	End,
}

/**
 * Classify `text` as a strict-JSON value, prefix, or dead end.
 *
 * Providers use this to disambiguate identifierless streaming tool-call
 * deltas: a chunk starting with `{` is a *new* sibling call only if the
 * current call's argument buffer cannot absorb it — the buffer is already a
 * complete value, already unsalvageable (lossy hosts abandon buffers
 * mid-string, leaving raw control characters strict JSON forbids), or the
 * concatenation would break it. Unlike {@link parseStreamingJson} this is
 * deliberately strict: forgiving repair would mask exactly the corruption
 * signals the caller needs.
 *
 * A top-level number at end-of-input classifies as `"complete"` even though
 * more digits could extend it; tool-argument buffers are always objects, so
 * the ambiguity is immaterial here.
 *
 * Stateless wrapper over {@link JsonPrefixScanner}; callers that classify a
 * growing buffer repeatedly should keep a scanner instead.
 */
export function classifyJsonPrefix(text: string): JsonPrefixState {
	const scanner = new JsonPrefixScanner();
	scanner.feed(text);
	return scanner.state;
}

// Number grammar phases for the resumable scanner (plain constants, not an enum).
/** Not inside a number. */
const NUM_NONE = 0;
/** After `-`: a digit must follow. */
const NUM_SIGN = 1;
/** After a leading `0`: only `.`, `e`/`E`, or the end may follow. */
const NUM_ZERO = 2;
/** Inside integer digits `1-9…`. */
const NUM_INT = 3;
/** After `.`: a digit must follow. */
const NUM_FRAC_START = 4;
const NUM_FRAC = 5;
/** After `e`/`E`: a sign or digit must follow. */
const NUM_EXP_START = 6;
/** After the exponent sign: a digit must follow. */
const NUM_EXP_SIGN = 7;
const NUM_EXP = 8;

/**
 * Resumable form of {@link classifyJsonPrefix}: `feed` appends text and the
 * scanner continues from where it stopped, so classifying a buffer that grows
 * by appends costs O(appended) per step instead of O(buffer). After any
 * sequence of feeds, {@link state} equals `classifyJsonPrefix(allFedText)`.
 *
 * Strings and numbers resume mid-token: escape and `\uXXXX` progress and the
 * number grammar phase are kept, so arbitrarily long tokens are scanned once.
 * A keyword (`true`/`false`/`null`) cut by a chunk boundary is held back, at
 * most four characters, and rescanned with the next chunk.
 */
export class JsonPrefixScanner {
	/** Total characters fed so far. */
	consumed = 0;
	// Container stack: true = object, false = array.
	#stack: boolean[] = [];
	#expect = JsonExpect.Value;
	#invalid = false;
	/** Inside a string: whether it is an object key (the next expectation is a colon). */
	#inString = false;
	#stringIsKey = false;
	/** Inside a string escape: just saw `\`. */
	#afterBackslash = false;
	/** Inside a string escape: `\u` hex digits still expected. */
	#hexLeft = 0;
	/** Unfinished keyword text at the end of input (at most 4 chars), rescanned on the next feed. */
	#pendingKeyword = "";
	/** Number grammar phase (`NUM_*`) while inside a number token, else `NUM_NONE`. */
	#numPhase = NUM_NONE;

	get state(): JsonPrefixState {
		if (this.#invalid) return "invalid";
		if (this.#inString) return "prefix";
		if (this.#pendingKeyword.length > 0) return "prefix";
		if (this.#numPhase !== NUM_NONE) {
			// A number can end after any digit: integer, fraction or exponent.
			const canEnd =
				this.#numPhase === NUM_ZERO ||
				this.#numPhase === NUM_INT ||
				this.#numPhase === NUM_FRAC ||
				this.#numPhase === NUM_EXP;
			return canEnd && this.#stack.length === 0 ? "complete" : "prefix";
		}
		return this.#expect === JsonExpect.End ? "complete" : "prefix";
	}

	/** Independent copy: probe a continuation without advancing this scanner. */
	clone(): JsonPrefixScanner {
		const copy = new JsonPrefixScanner();
		copy.consumed = this.consumed;
		copy.#stack = this.#stack.slice();
		copy.#expect = this.#expect;
		copy.#invalid = this.#invalid;
		copy.#inString = this.#inString;
		copy.#stringIsKey = this.#stringIsKey;
		copy.#afterBackslash = this.#afterBackslash;
		copy.#hexLeft = this.#hexLeft;
		copy.#pendingKeyword = this.#pendingKeyword;
		copy.#numPhase = this.#numPhase;
		return copy;
	}

	feed(chunk: string): JsonPrefixState {
		this.consumed += chunk.length;
		if (this.#invalid || chunk.length === 0) return this.state;
		let text = chunk;
		if (this.#pendingKeyword.length > 0) {
			text = this.#pendingKeyword + chunk;
			this.#pendingKeyword = "";
		}
		if (!this.#scan(text)) this.#invalid = true;
		return this.state;
	}

	/** Next expectation once a value finishes, from the container stack. */
	#valueDone(): JsonExpect {
		const stack = this.#stack;
		return stack.length === 0
			? JsonExpect.End
			: stack[stack.length - 1]
				? JsonExpect.ObjCommaOrEnd
				: JsonExpect.ArrCommaOrEnd;
	}

	/** Continue a string body at `i`. Returns the index after the closing quote, `n` if unfinished, or -1 if invalid. */
	#scanString(text: string, i: number): number {
		const n = text.length;
		while (i < n) {
			const c = text.charCodeAt(i);
			if (this.#afterBackslash) {
				if (c >= 128 || !VALID_ESCAPE_CHAR[c]) return -1;
				this.#afterBackslash = false;
				if (c === U) this.#hexLeft = 4;
				i++;
				continue;
			}
			if (this.#hexLeft > 0) {
				if (!isHexDigit(c)) return -1;
				this.#hexLeft--;
				i++;
				continue;
			}
			if (c === QUOTE) {
				this.#inString = false;
				this.#expect = this.#stringIsKey ? JsonExpect.ObjColon : this.#valueDone();
				return i + 1;
			}
			if (c === BACKSLASH) this.#afterBackslash = true;
			else if (c < 0x20) return -1; // raw control char: strict JSON forbids it
			i++;
		}
		return n;
	}

	/**
	 * Continue a number at `i` from {@link #numPhase}. On a character that cannot
	 * extend it, the number ends (if its phase allows) and that index is
	 * returned for the main loop. Returns `n` while unfinished, -1 if invalid.
	 */
	#scanNumber(text: string, i: number): number {
		const n = text.length;
		let phase = this.#numPhase;
		for (; i < n; i++) {
			const c = text.charCodeAt(i);
			const digit = c >= 0x30 && c <= 0x39;
			switch (phase) {
				case NUM_SIGN:
					if (c === 0x30) phase = NUM_ZERO;
					else if (digit) phase = NUM_INT;
					else return -1;
					continue;
				case NUM_ZERO:
				case NUM_INT:
					if (digit && phase === NUM_INT) continue;
					if (c === 0x2e) phase = NUM_FRAC_START;
					else if (c === 0x65 || c === 0x45) phase = NUM_EXP_START;
					else return this.#endNumber(i);
					continue;
				case NUM_FRAC_START:
					if (!digit) return -1;
					phase = NUM_FRAC;
					continue;
				case NUM_FRAC:
					if (digit) continue;
					if (c === 0x65 || c === 0x45) phase = NUM_EXP_START;
					else return this.#endNumber(i);
					continue;
				case NUM_EXP_START:
					if (c === 0x2b || c === 0x2d) phase = NUM_EXP_SIGN;
					else if (digit) phase = NUM_EXP;
					else return -1;
					continue;
				case NUM_EXP_SIGN:
					if (!digit) return -1;
					phase = NUM_EXP;
					continue;
				default: // NUM_EXP
					if (digit) continue;
					return this.#endNumber(i);
			}
		}
		this.#numPhase = phase;
		return n;
	}

	#endNumber(i: number): number {
		this.#numPhase = NUM_NONE;
		this.#expect = this.#valueDone();
		return i;
	}

	/** Scan `text` from the current state. Returns false once the input is invalid. */
	#scan(text: string): boolean {
		const n = text.length;
		let i = 0;
		if (this.#inString) {
			i = this.#scanString(text, i);
			if (i < 0) return false;
		} else if (this.#numPhase !== NUM_NONE) {
			i = this.#scanNumber(text, i);
			if (i < 0) return false;
		}
		while (i < n) {
			const c = text.charCodeAt(i);
			if (isWhitespace(c)) {
				i++;
				continue;
			}
			switch (this.#expect) {
				case JsonExpect.Value:
				case JsonExpect.ArrValueOrEnd: {
					if (c === 0x5d && this.#expect === JsonExpect.ArrValueOrEnd) {
						this.#stack.pop();
						i++;
						this.#expect = this.#valueDone();
						break;
					}
					if (c === 0x7b) {
						this.#stack.push(true);
						i++;
						this.#expect = JsonExpect.ObjKeyOrEnd;
						break;
					}
					if (c === 0x5b) {
						this.#stack.push(false);
						i++;
						this.#expect = JsonExpect.ArrValueOrEnd;
						break;
					}
					if (c === QUOTE) {
						this.#inString = true;
						this.#stringIsKey = false;
						i = this.#scanString(text, i + 1);
						if (i < 0) return false;
						break;
					}
					if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
						this.#numPhase = c === 0x2d ? NUM_SIGN : c === 0x30 ? NUM_ZERO : NUM_INT;
						i = this.#scanNumber(text, i + 1);
						if (i < 0) return false;
						break;
					}
					if (c === 0x74 || c === 0x66 || c === 0x6e) {
						const word = c === 0x74 ? "true" : c === 0x66 ? "false" : "null";
						const available = Math.min(word.length, n - i);
						if (!word.startsWith(text.slice(i, i + available))) return false;
						if (available < word.length) {
							this.#pendingKeyword = text.slice(i);
							return true;
						}
						i += available;
						this.#expect = this.#valueDone();
						break;
					}
					return false;
				}
				case JsonExpect.ObjKeyOrEnd:
				case JsonExpect.ObjKey: {
					if (c === 0x7d && this.#expect === JsonExpect.ObjKeyOrEnd) {
						this.#stack.pop();
						i++;
						this.#expect = this.#valueDone();
						break;
					}
					if (c !== QUOTE) return false;
					this.#inString = true;
					this.#stringIsKey = true;
					i = this.#scanString(text, i + 1);
					if (i < 0) return false;
					break;
				}
				case JsonExpect.ObjColon:
					if (c !== 0x3a) return false;
					i++;
					this.#expect = JsonExpect.Value;
					break;
				case JsonExpect.ObjCommaOrEnd:
					if (c === 0x7d) {
						this.#stack.pop();
						i++;
						this.#expect = this.#valueDone();
						break;
					}
					if (c !== 0x2c) return false;
					i++;
					this.#expect = JsonExpect.ObjKey;
					break;
				case JsonExpect.ArrCommaOrEnd:
					if (c === 0x5d) {
						this.#stack.pop();
						i++;
						this.#expect = this.#valueDone();
						break;
					}
					if (c !== 0x2c) return false;
					i++;
					this.#expect = JsonExpect.Value;
					break;
				case JsonExpect.End:
					return false; // trailing non-whitespace after a complete value
			}
		}
		return true;
	}
}
