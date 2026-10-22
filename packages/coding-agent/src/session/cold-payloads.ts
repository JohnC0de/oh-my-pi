import * as fs from "node:fs";
import * as path from "node:path";
import { getBlobsDir, logger } from "@oh-my-pi/pi-utils";
import { BlobStore } from "./blob-store";
type ColdValue = string | number | boolean | bigint | symbol | null | undefined | object;

const liveDirectories = new Set<string>();

function removeBacking(directory: string): void {
	try {
		fs.rmSync(directory, { recursive: true, force: true });
		liveDirectories.delete(directory);
	} catch (error) {
		logger.debug("Cold session payload cleanup failed", { error: String(error) });
	}
}

const cleanup = new FinalizationRegistry<string>(removeBacking);
process.once("exit", () => {
	for (const directory of liveDirectories) removeBacking(directory);
});

/** Process-local backing only: durable journals and their blob reachability stay unchanged.
 * Accessors hold this store alive even when callers retain entries past manager close.
 */
export class ColdPayloadStore {
	#store: BlobStore | undefined;

	#backing(): BlobStore {
		if (!this.#store) {
			// Keep backing beside durable blobs, not a potentially RAM-backed /tmp.
			const parent = path.join(path.dirname(getBlobsDir()), "cold-payloads");
			fs.mkdirSync(parent, { recursive: true });
			const directory = fs.mkdtempSync(path.join(parent, `${process.pid}-`));
			liveDirectories.add(directory);
			this.#store = new BlobStore(directory);
			cleanup.register(this, directory);
		}
		return this.#store;
	}

	#install(owner: object, key: string, hash: string): void {
		Object.defineProperty(owner, key, {
			configurable: true,
			enumerable: true,
			get: () => {
				const bytes = this.#backing().getSync(hash);
				if (!bytes) throw new Error(`Cold session payload is missing: ${hash}`);
				return bytes.toString("utf16le");
			},
			set(value: ColdValue) {
				Object.defineProperty(this, key, { value, writable: true, configurable: true, enumerable: true });
			},
		});
	}

	/** Keep object identities and ordinary mutable property semantics; never cache reads. */
	release(value: object, seen = new WeakSet<object>()): void {
		if (seen.has(value)) return;
		seen.add(value);
		for (const key of Object.keys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !descriptor.configurable || !descriptor.writable || !descriptor.enumerable) continue;
			const child = descriptor.value as ColdValue;
			if (typeof child === "string" && child.length >= 16_384) {
				const stored = this.#backing().putSync(Buffer.from(child, "utf16le"));
				this.#install(value, key, stored.hash);
			} else if (typeof child === "object" && child !== null) {
				this.release(child, seen);
			}
		}
	}
}
