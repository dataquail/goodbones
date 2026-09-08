import react from "@vitejs/plugin-react";
import { mergeConfig, type UserConfigExport } from "vitest/config";

import shared from "../../vitest.shared.js";

// The view components run in jsdom; ELK is stubbed where a test needs a
// layout. No browser automation here — that is not in `precommit`.
const config: UserConfigExport = {
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: [],
  },
};

export default mergeConfig(shared, config);
