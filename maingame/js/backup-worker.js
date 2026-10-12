importScripts("./chess.js");

self.addEventListener("message", async ({ data }) => {
  try {
    const { validateBackup } = await import("./storage.mjs");
    self.postMessage({ ok: true, valid: validateBackup(JSON.parse(await data.text())) });
  } catch (error) {
    self.postMessage({ ok: false, error: error.message || "This backup could not be validated." });
  }
});
