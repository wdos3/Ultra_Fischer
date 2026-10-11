import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

for (const name of readdirSync("maingame/js").filter((name) => /\.(mjs|js)$/.test(name) && !name.includes("jquery"))) {
  const result = spawnSync(process.execPath, ["--check", "maingame/js/" + name], { stdio: "inherit" });
  if (result.status) process.exit(result.status);
}
