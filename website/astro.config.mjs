import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    starlight({
      title: "Goodbones",
      description:
        "Architecture policy as one manifest of your repository, enforced by oxlint and a CLI — and refactors tracked as campaigns that only move forward.",
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
      ],
    }),
  ],
  site: "https://dataquail.github.io",
  base: "/goodbones",
});
