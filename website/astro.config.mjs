import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import mermaid from "astro-mermaid";

export default defineConfig({
  integrations: [
    // Renders the ```mermaid fences `architecture diagram` produces, in the
    // reader's theme. Listed before Starlight, as the integration asks.
    mermaid({ autoTheme: true }),
    starlight({
      title: "Oxlint Utils",
      description:
        "Oxlint plugins and tooling from dataquail. Architecture Rules turns architecture policy into one manifest of your repository, enforced by oxlint.",
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
                { slug: "architecture-rules/manifest/imported-by" },
                { slug: "architecture-rules/manifest/exports" },
                { slug: "architecture-rules/manifest/members" },
                { slug: "architecture-rules/manifest/surface" },
                { slug: "architecture-rules/manifest/graph" },
                { slug: "architecture-rules/manifest/structure" },
                { slug: "architecture-rules/manifest/inheritance" },
                { slug: "architecture-rules/manifest/layers" },
                { slug: "architecture-rules/manifest/javascript" },
              ],
            },
            {
              label: "Enforcement",
              items: [
                { slug: "architecture-rules/enforcement/resolution" },
                { slug: "architecture-rules/enforcement/probes" },
                { slug: "architecture-rules/enforcement/baseline" },
                { slug: "architecture-rules/enforcement/adoption" },
                { slug: "architecture-rules/enforcement/conformance" },
                { slug: "architecture-rules/enforcement/diagram" },
                { slug: "architecture-rules/enforcement/explore" },
                { slug: "architecture-rules/enforcement/cli" },
              ],
            },
          ],
        },
      ],
    }),
  ],
  site: "https://dataquail.github.io",
  base: "/goodbones",
});
