import { mergeConfig, type UserConfigExport } from "vitest/config";

import shared from "../../vitest.shared.js";

// The React components are tested under jsdom; each such file says so with a
// `@vitest-environment jsdom` directive, so the model and server tests keep
// running in Node.
const config: UserConfigExport = {
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
};

export default mergeConfig(shared, config);
