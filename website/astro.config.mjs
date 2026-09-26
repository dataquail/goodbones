import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";

// One surface for every code frame — the block, its tab bar and a terminal's title bar — a step
// off the page ground in each theme.
const surface = ({ theme }) => (theme.type === "dark" ? "#1a1816" : "#f4f1ea");

export default defineConfig({
  integrations: [
    starlight({
      title: "Goodbones",
      description:
        "Architecture policy as one manifest of your repository, enforced by oxlint and a CLI — and refactors tracked as campaigns that only move forward.",
      logo: {
        light: "./src/assets/mark-light.svg",
        dark: "./src/assets/mark-dark.svg",
        alt: "",
      },
      customCss: [
        "@fontsource-variable/atkinson-hyperlegible-next",
        "@fontsource-variable/atkinson-hyperlegible-mono",
        "./src/styles/theme.css",
      ],
      // Code blocks match the theme: the Vitesse pair is already quiet, and the frame loses
      // its shadow and takes the same hairline and radius as everything else.
      expressiveCode: {
        themes: ["vitesse-dark", "vitesse-light"],
        styleOverrides: {
          borderRadius: "0.375rem",
          borderColor: "var(--sl-color-hairline)",
          codeFontFamily: "var(--__sl-font-mono)",
          uiFontFamily: "var(--__sl-font)",
          codeBackground: surface,
          frames: {
            shadowColor: "transparent",
            editorTabBarBackground: surface,
            editorActiveTabBackground: surface,
            editorActiveTabIndicatorTopColor: "transparent",
            editorActiveTabIndicatorBottomColor: "var(--sl-color-accent)",
            editorTabBarBorderBottomColor: "var(--sl-color-hairline)",
            terminalBackground: surface,
            terminalTitlebarBackground: surface,
            terminalTitlebarBorderBottomColor: "var(--sl-color-hairline)",
            terminalTitlebarDotsOpacity: "0.3",
          },
        },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/dataquail/goodbones",
        },
      ],
      // One group per package, so a second library lands beside this one rather
      // than inside it.
      sidebar: [
        {
          label: "Architecture Rules",
          items: [
            {
              label: "Getting Started",
              items: [
                { slug: "architecture-rules/getting-started/introduction" },
                { slug: "architecture-rules/getting-started/installation" },
                { slug: "architecture-rules/getting-started/infer" },
              ],
            },
            {
              label: "The Manifest",
              items: [
                { slug: "architecture-rules/manifest", label: "Overview" },
                { slug: "architecture-rules/manifest/patterns" },
                { slug: "architecture-rules/manifest/imports" },
                { slug: "architecture-rules/manifest/exports" },
                { slug: "architecture-rules/manifest/members" },
                { slug: "architecture-rules/manifest/surface" },
                { slug: "architecture-rules/manifest/graph" },
                { slug: "architecture-rules/manifest/structure" },
                { slug: "architecture-rules/manifest/inheritance" },
                { slug: "architecture-rules/manifest/organizing" },
              ],
            },
            {
              label: "Enforcement",
              items: [
                { slug: "architecture-rules/enforcement/resolution" },
                { slug: "architecture-rules/enforcement/probes" },
                { slug: "architecture-rules/enforcement/adoption" },
                { slug: "architecture-rules/enforcement/conformance" },
                { slug: "architecture-rules/enforcement/cli" },
              ],
            },
          ],
        },
        {
          label: "Campaigns",
          items: [
            {
              label: "Getting Started",
              items: [
                { slug: "campaigns/getting-started/introduction" },
                { slug: "campaigns/getting-started/installation" },
              ],
            },
            {
              label: "Defining a Campaign",
              items: [
                { slug: "campaigns/manifest", label: "Overview" },
                { slug: "campaigns/manifest/objectives" },
                { slug: "campaigns/manifest/scalars" },
                { slug: "campaigns/manifest/sectors" },
                { slug: "campaigns/manifest/phases" },
                { slug: "campaigns/manifest/detectors" },
              ],
            },
            {
              label: "Running a Campaign",
              items: [
                { slug: "campaigns/running/ledger" },
                { slug: "campaigns/running/nudge" },
                { slug: "campaigns/running/cli" },
              ],
            },
          ],
        },
        {
          label: "Browser",
          items: [{ slug: "browser/introduction" }],
        },
      ],
    }),
  ],
  // The site's only images are SVG, which need no optimizing, so no Sharp.
  image: { service: passthroughImageService() },
  // Pages folded into others by the concision pass, kept reachable at their old URLs.
  redirects: {
    "/architecture-rules/manifest/imported-by":
      "/goodbones/architecture-rules/manifest/imports/#importedby",
    "/architecture-rules/manifest/javascript": "/goodbones/architecture-rules/manifest/organizing/",
    "/architecture-rules/enforcement/baseline":
      "/goodbones/architecture-rules/enforcement/adoption/",
  },
  site: "https://dataquail.github.io",
  base: "/goodbones",
});
