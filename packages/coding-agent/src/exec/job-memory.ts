import { Process } from "@oh-my-pi/pi-natives";
import { isEnoent } from "@oh-my-pi/pi-utils";

export interface JobMemoryFailure {
	message: string;
	limitBytes: number;
	observedBytes?: number;
}

/** RSS is sampled, not reserved: short spikes can overshoot between samples.
 * Shared pages are conservatively counted once per process. Never measures OMP.
 */
export function monitorJobMemory(
	pids: () => readonly number[],
	limitMb: number,
	onFailure: (failure: JobMemoryFailure) => void,
): () => Promise<void> {
	if (limitMb === 0) return async () => {};
	const limitBytes = limitMb * 1024 * 1024;
	let stopped = false;
	if (!Number.isFinite(limitMb) || limitMb < 0) {
		throw new Error("bash.memoryLimitMb must be a non-negative finite number (0 disables)");
	}
	let pending: Promise<void> = Promise.resolve();
	const sample = async () => {
		const seen = new Set<number>();
		const queue = pids().flatMap(pid => {
			if (pid === process.pid) return [];
			const ref = Process.fromPid(pid);
			return ref ? [ref] : [];
		});
		let observedBytes = 0;
		for (let index = 0; index < queue.length && !stopped; index++) {
			const ref = queue[index];
			if (seen.has(ref.pid) || ref.pid === process.pid) continue;
			seen.add(ref.pid);
			queue.push(...ref.children());
			if (process.platform === "linux") {
				try {
					const status = await Bun.file(`/proc/${ref.pid}/status`).text();
					observedBytes += Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024;
				} catch (error) {
					if (!isEnoent(error)) throw error;
				}
			} else {
				throw new Error(
					"RSS monitoring is supported on Linux; set bash.memoryLimitMb to 0 to disable it on this platform",
				);
			}
		}
		if (!stopped && observedBytes > limitBytes) {
			stopped = true;
			onFailure({
				limitBytes,
				observedBytes,
				message: `Command memory limit exceeded: process tree RSS ${Math.ceil(observedBytes / 1024 / 1024)} MiB > ${limitMb} MiB. Reduce parallelism/workload or raise bash.memoryLimitMb (0 disables).`,
			});
		}
	};
	const tick = () => {
		pending = sample()
			.catch(error => {
				if (stopped) return;
				stopped = true;
				onFailure({ limitBytes, message: `Command stopped because memory supervision failed: ${String(error)}` });
			})
			.finally(() => {
				if (!stopped) timer = setTimeout(tick, 250);
			});
	};
	let timer: NodeJS.Timeout | undefined = setTimeout(tick, 250);
	return async () => {
		stopped = true;
		clearTimeout(timer);
		await pending;
	};
}
