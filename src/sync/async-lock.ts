/**
 * Serializes async work behind a single queue: `run` chains onto whatever is
 * already pending, so callers never poll a "busy" flag — they just await.
 *
 * Exists because the orchestrator's own single-flight guard only serializes
 * sync-vs-sync; nothing previously stopped a one-off engine operation (setup
 * wizard clone/init, Danger Zone re-clone/discard) from running concurrently
 * with an in-flight auto-sync against the same `.git` directory.
 */
export class AsyncLock {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release: () => void = () => {};
		this.tail = new Promise<void>((r) => {
			release = r;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}
