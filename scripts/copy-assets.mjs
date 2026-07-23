// Copies the non-TypeScript files a built extension/hook needs (GNOME Shell
// extensions load metadata.json + icons from their own directory; there's
// nothing here for tsc to compile) into dist/ alongside the compiled JS.
import { chmodSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

cpSync(
  join(root, "extension", "metadata.json"),
  join(root, "dist", "extension", "metadata.json"),
);
mkdirSync(join(root, "dist", "extension", "icons"), { recursive: true });
cpSync(join(root, "extension", "icons"), join(root, "dist", "extension", "icons"), {
  recursive: true,
});
cpSync(
  join(root, "extension", "detailed-usage.py"),
  join(root, "dist", "extension", "detailed-usage.py"),
);
cpSync(
  join(root, "extension", "ascii.txt"),
  join(root, "dist", "extension", "ascii.txt"),
);

// Optional dev-mode flag (CLAUDEWATCH_DEV=1) — see docs/TESTING.md's "Dev
// preview menu". Copied only when present so a normal checkout without a
// root .env doesn't ship anything extra; indicator.ts's readDevModeFlag()
// reads it back from next to the assets copied above.
const dotEnvPath = join(root, ".env");
if (existsSync(dotEnvPath)) {
  cpSync(dotEnvPath, join(root, "dist", "extension", ".env"));
}

chmodSync(join(root, "dist", "hooks", "hook-handler.js"), 0o755);
chmodSync(join(root, "dist", "extension", "detailed-usage.py"), 0o755);
