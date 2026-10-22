import { expect, test } from "bun:test";
import { ColdPayloadStore } from "../../src/session/cold-payloads";

test("cold payload reads preserve UTF-16 bytes and archived field mutations remain serializable", () => {
	const store = new ColdPayloadStore();
	const original = "payload\ud800".repeat(4096);
	const block = { text: original };
	const entry = { content: [block, block] };
	store.release(entry);
	expect(entry.content[0]).toBe(entry.content[1]);
	expect(block.text).toBe(original);
	expect(JSON.parse(JSON.stringify(entry)).content[0].text).toBe(original);
	block.text = "edited archived text";
	expect(structuredClone(entry).content[0].text).toBe("edited archived text");
	store.release(entry);
	expect(block.text).toBe("edited archived text");
});

test("retained archived entries remain readable after the store owner's scope ends", () => {
	function archive() {
		const store = new ColdPayloadStore();
		const entry = { content: [{ text: "history".repeat(4096) }] };
		store.release(entry);
		return entry;
	}
	const retained = archive();
	Bun.gc(true);
	expect(retained.content[0].text).toBe("history".repeat(4096));
});
