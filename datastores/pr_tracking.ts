import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";

/**
 * Tracks the review state of each PR posted to the channel, keyed by the
 * Slack message that announced it. One row per PR post.
 */
const PrTrackingDatastore = DefineDatastore({
  name: "PrTracking",
  primary_key: "pr_key",
  attributes: {
    pr_key: {
      type: Schema.types.string,
    },
    channel_id: {
      type: Schema.types.string,
    },
    message_ts: {
      type: Schema.types.string,
    },
    permalink: {
      type: Schema.types.string,
    },
    github_owner: {
      type: Schema.types.string,
    },
    github_repo: {
      type: Schema.types.string,
    },
    pr_number: {
      type: Schema.types.integer,
    },
    author_user_id: {
      type: Schema.types.string,
    },
    has_looking: {
      type: Schema.types.boolean,
    },
    has_approved: {
      type: Schema.types.boolean,
    },
    // YYYY-MM-DD date the 👀 reaction was first observed, or "" if never seen
    first_seen_looking_date: {
      type: Schema.types.string,
    },
    looking_user_ids: {
      type: Schema.types.array,
      items: {
        type: Schema.types.string,
      },
    },
    merged: {
      type: Schema.types.boolean,
    },
    last_checked_date: {
      type: Schema.types.string,
    },
  },
});

export default PrTrackingDatastore;
