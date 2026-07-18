// SPDX-License-Identifier: GPL-2.0-or-later

import path from "path";
import { defineConfig } from "vitest/config";

// state.ts and rateLimit.ts import "gi://GLib" at module scope; that
// specifier doesn't resolve under Node, so tests get a minimal fake instead.
// See test/gjs-stubs/glib.ts for what it covers and why.
export default defineConfig({
  resolve: {
    alias: {
      "gi://GLib": path.resolve(__dirname, "test/gjs-stubs/glib.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Pinned so rateLimit.test.ts's date-formatting assertions don't depend
    // on the host machine's local timezone.
    env: { TZ: "UTC" },
  },
});
