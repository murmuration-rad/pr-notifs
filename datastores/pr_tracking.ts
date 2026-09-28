import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";

/**
 * Tracks the review state of each PR linked in the channel. One row per
 * (message, linked PR) pair — a single message can link multiple PRs (e.g.
 * a batch "N of mine open for review" post), each tracked independently,
 * though they share the posting message's 👀/✅ reactions since Slack can't
 * react to just one link within a message.
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
