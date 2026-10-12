import test from "node:test";
import assert from "node:assert/strict";
import { validateBackupFile } from "./backup-validator.mjs";

class FakeWorker extends EventTarget {
  postMessage(file) { this.file = file; }
  emit(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  terminate() { this.terminated = true; }
}

test("backup validation sends a file to the worker and terminates on success", async () => {
  const worker = new FakeWorker();
  const file = new Blob(['{"games":[]}']);
  const result = validateBackupFile(file, { workerFactory: () => worker });
  assert.equal(worker.file, file);
  worker.emit({ ok: true, valid: { games: [] } });
  assert.deepEqual(await result, { games: [] });
  assert.equal(worker.terminated, true);
});

test("failed and timed-out backup validation never leave a worker running", async () => {
  const failedWorker = new FakeWorker();
  const failed = validateBackupFile(new Blob(), { workerFactory: () => failedWorker });
  failedWorker.emit({ ok: false, error: "Invalid backup" });
  await assert.rejects(failed, /Invalid backup/);
  assert.equal(failedWorker.terminated, true);
  const hungWorker = new FakeWorker();
  await assert.rejects(validateBackupFile(new Blob(), { workerFactory: () => hungWorker, timeoutMs: 15 }), /timed out/);
  assert.equal(hungWorker.terminated, true);
});
