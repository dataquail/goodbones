// The browsers' data, and the server pieces a host composes them with. The
// page itself is under `build/site`, served by the `goodbones-browser` bin.
export {
  type Atlas,
  type AtlasAllowance,
  type AtlasEdge,
  type AtlasExternal,
  type AtlasFile,
  type AtlasFolder,
  type AtlasInput,
  type AtlasNode,
  type AtlasPosition,
  type AtlasRule,
  type AtlasViolation,
  buildAtlas,
  type EdgeStatus,
} from "./model/atlas.js";
export {
  type CampaignCard,
  type CampaignView,
  type CampaignViewInput,
  campaignViewOf,
  type HitCard,
  type ObjectiveCard,
  type ObjectiveSectorCard,
  type PhaseCard,
  type SectorCard,
} from "./model/campaigns.js";
export { collect, type Collected, type CollectOptions, collectWith } from "./server/collect.js";
export { type LoadedManifest, loadPolicyFromFile } from "./server/compose.js";
export { exportSite } from "./server/export.js";
export { type Handler, makeHandler, PREFIX } from "./server/handler.js";
export { serve, type Served, type ServeOptions } from "./server/serve.js";
export { SITE_DIR } from "./server/site.js";
export { type Change, makeSource, type Source, type SourceOptions } from "./server/source.js";
export { type BrowserPluginOptions, goodbonesBrowser } from "./server/vite-plugin.js";
export { isRelevant, type WatchOptions, watchRepository } from "./server/watch.js";
