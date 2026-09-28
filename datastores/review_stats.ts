import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";

/**
 * Tracks each person's best-ever day of "reviews started" (new 👀
 * reactions observed in a single daily check), purely for the fun stat
 * called out in the daily summary.
 */
const ReviewStatsDatastore = DefineDatastore({
  name: "ReviewStats",
  primary_key: "user_id",
  attributes: {
    user_id: {
      type: Schema.types.string,
    },
    best_day_count: {
      type: Schema.types.integer,
    },
    // YYYY-MM-DD date the best_day_count was set
    best_day_date: {
      type: Schema.types.string,
    },
    last_count: {
      type: Schema.types.integer,
    },
  },
});

export default ReviewStatsDatastore;
