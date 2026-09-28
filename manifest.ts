import { Manifest } from "deno-slack-sdk/mod.ts";
import DailySummaryWorkflow from "./workflows/daily_summary.ts";
import PrTrackingDatastore from "./datastores/pr_tracking.ts";
import ReviewStatsDatastore from "./datastores/review_stats.ts";

/**
 * The app manifest contains the app's configuration. This
 * file defines attributes like app name and description.
 * https://api.slack.com/automation/manifest
 */
export default Manifest({
  name: "pr-notifs",
  description:
    "Posts a beginning-of-day summary of stalled PR reviews to #rad-eng-pull-requests",
  icon: "assets/default_new_app_icon.png",
  workflows: [DailySummaryWorkflow],
  outgoingDomains: ["api.github.com"],
  datastores: [PrTrackingDatastore, ReviewStatsDatastore],
  botScopes: [
    "commands",
    "chat:write",
    "chat:write.public",
    "channels:history",
    "reactions:read",
    "datastore:read",
    "datastore:write",
  ],
});
