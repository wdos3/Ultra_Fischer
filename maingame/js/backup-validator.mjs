export function validateBackupText(text, { workerFactory = (url) => new Worker(url), timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = workerFactory(new URL("./backup-worker.js", import.meta.url));
    let settled = false;
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(null, new Error("Backup validation timed out. No records were imported.")), timeoutMs);
    worker.addEventListener("message", ({ data }) => {
      if (data?.ok) finish(data.valid);
      else finish(null, new Error(data?.error || "Backup validation failed."));
    });
    worker.addEventListener("error", () => finish(null, new Error("The backup validator could not run. No records were imported.")));
    worker.addEventListener("messageerror", () => finish(null, new Error("The backup validator returned an unreadable result.")));
    try { worker.postMessage(text); } catch (error) { finish(null, error); }
  });
}
