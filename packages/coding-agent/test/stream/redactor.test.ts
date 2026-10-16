import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StreamRedactor } from "@oh-my-pi/pi-coding-agent/stream/redactor";
import { logger } from "@oh-my-pi/pi-utils";

let redactor: StreamRedactor;
let cwd: string;

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stream-redactor-"));
	redactor = await StreamRedactor.load(cwd, []);
});

afterAll(async () => {
	await fs.rm(cwd, { force: true, recursive: true });
});

describe("StreamRedactor", () => {
	it("redacts a vendor token while it is still being typed", () => {
		expect(redactor.redactRow("token sk-ant-api03-x pending")).toBe("token •••••• pending");
	});

	it("redacts an incomplete six-character prefix of a dotenv-derived value", async () => {
		const name = "STREAM_REDACTOR_PUBLIC_LABEL";
		const value = "source-value-987654";
		const previous = process.env[name];
		process.env[name] = value;
		await Bun.write(path.join(cwd, ".env"), `${name}=${value}\n`);
		try {
			const dotenvRedactor = await StreamRedactor.load(cwd, []);
			expect(dotenvRedactor.redactRow("typing source")).toBe("typing ••••••");
		} finally {
			if (previous === undefined) delete process.env[name];
			else process.env[name] = previous;
			await fs.rm(path.join(cwd, ".env"), { force: true });
		}
	});

	it("drops ANSI styling from a row containing a secret", async () => {
		const styledRedactor = await StreamRedactor.load(cwd, ["styled-secret"]);
		const row = "value \x1b[31mstyled-secret\x1b[0m remains";
		expect(styledRedactor.redactRow(row)).toBe("value •••••• remains");
	});

	it("returns the original benign row unchanged", () => {
		const row = "compilation finished successfully";
		expect(redactor.redactRow(row)).toBe(row);
	});

	it("preserves source-location JSON and short non-secret status counts", () => {
		const isolated = new StreamRedactor([], []);
		for (const row of ['{"key":"src/a.ts","line":10,"msg":"unused"}', "PASS: 42"]) {
			expect(isolated.redactRow(row)).toBe(row);
		}
		expect(isolated.redactRow('{"API_KEY":"abcd1234","line":10}')).toBe('{"API_KEY":••••••,"line":10}');
	});

	it("redacts only the value in a secret assignment", () => {
		expect(redactor.redactRow("prefix API_KEY=abcd1234 suffix")).toBe("prefix API_KEY=•••••• suffix");
	});

	it.each([
		["export DB_PASSWORD=sample,comma-value", "export DB_PASSWORD=••••••"],
		["TOKEN=abc,synthetic-value", "TOKEN=••••••"],
		["API_KEY=xy{synthetic-value}", "API_KEY=••••••"],
		["PASSWORD=ab}synthetic-value", "PASSWORD=••••••"],
		["TOKEN=abc", "TOKEN=••••••"],
		['"AUTH_TOKEN"=synthetic,value}', '"AUTH_TOKEN"=••••••'],
		['env["API_KEY"]=synthetic,value}', 'env["API_KEY"]=••••••'],
		["env['API_KEY']='synthetic value'", "env['API_KEY']=••••••"],
		['{"TOKEN":abc,"line":10}', '{"TOKEN":••••••,"line":10}'],
		['{"API_KEY":"xy{synthetic,value}","line":10}', '{"API_KEY":••••••,"line":10}'],
	])("redacts punctuation without consuming adjacent JSON fields: %s", (input, expected) => {
		expect(new StreamRedactor([], []).redactRow(input)).toBe(expected);
	});

	it("redacts an opaque assignment argv element without leaking its whitespace-delimited suffix", () => {
		const isolated = new StreamRedactor([], []);
		expect(isolated.redactArgument("PASSWORD=synthetic alpha beta")).toBe("PASSWORD=••••••");
		expect(isolated.redactArgument('TOKEN=synthetic "quoted" suffix')).toBe("TOKEN=••••••");
		expect(isolated.redactCommand("PASSWORD=synthetic harmless-command")).toBe("PASSWORD=•••••• harmless-command");
	});

	it.each([
		"PASSWORD='synthetic alpha beta' true",
		'TOKEN="synthetic alpha beta" true',
		'PASSWORD="synthetic \\"alpha\\" beta" true',
		"PASSWORD='synthetic alpha'\" beta\" true",
		"PASSWORD=synthetic\\ alpha\\ beta true",
	])("redacts complete secret assignment words in %s", command => {
		const isolated = new StreamRedactor([], []);
		expect(isolated.redactCommand(command)).toBe(`${command.startsWith("TOKEN") ? "TOKEN" : "PASSWORD"}=•••••• true`);
		expect(isolated.redactRow(command)).not.toContain("synthetic");
		expect(isolated.redactRow(command)).not.toContain("beta");
	});

	it("redacts assignments inside shell-escaped nested command arguments", () => {
		const isolated = new StreamRedactor([], []);
		const command = `/bin/sh -c 'PASSWORD='"'"'synthetic alpha beta'"'"' true'`;
		const result = isolated.redactCommand(command);
		expect(result).not.toContain("synthetic");
		expect(result).not.toContain("beta");
		expect(result).toContain("PASSWORD=••••••");
	});

	it.each([
		{ word: "$'sy\\x6ethetic-value-123'", secret: "synthetic-value-123" },
		{ word: "$'sy\\156thetic-value-123'", secret: "synthetic-value-123" },
		{ word: "$'sy\\u006ethetic-value-123'", secret: "synthetic-value-123" },
		{ word: "$'sy\\U0000006ethetic-value-123'", secret: "synthetic-value-123" },
		{ word: "syn$'\\x74he'\"tic-value-123\"", secret: "synthetic-value-123" },
		{ word: "$'synthetic-\\'quoted\\'-value-123'", secret: "synthetic-'quoted'-value-123" },
		{ word: "$'synthetic-\\xc3\\xa9-value-123'", secret: "synthetic-é-value-123" },
		{ word: "$'synthetic-\\u00e9-value-123'", secret: "synthetic-é-value-123" },
	])("redacts the raw ANSI-C word when its decoded bytes match a known secret: $word", ({ word, secret }) => {
		const isolated = new StreamRedactor([], [{ value: secret, prefix: secret.slice(0, 6) }]);
		expect(isolated.redactCommand(`true ${word}`)).toBe("true ••••••");
	});

	it("does not rewrite harmless ANSI-C words or evaluate shell expansions while matching", () => {
		const isolated = new StreamRedactor([], []);
		const command = "true $'benign\\x20word' $'$(touch /must-not-run)'";
		expect(isolated.redactCommand(command)).toBe(command);
	});

	it("skips an invalid user pattern while applying the remaining patterns", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const customRedactor = await StreamRedactor.load(cwd, ["(", "custom-secret"]);
			expect(customRedactor.redactRow("found custom-secret here")).toBe("found •••••• here");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("redacts a connection URL password without hiding the username or host", () => {
		expect(redactor.redactRow("db postgres://alice:hunter2-db@db.local/main")).toBe(
			"db postgres://alice:••••••@db.local/main",
		);
	});
});
