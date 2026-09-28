import type { Trigger } from "deno-slack-sdk/types.ts";
import { TriggerTypes } from "deno-slack-api/mod.ts";
import DailySummaryWorkflow from "../workflows/daily_summary.ts";
import { PR_CHANNEL_ID } from "./config.ts";

/**
 * Fires weekday mornings at 9am America/New_York (DST-aware via the
 * `timezone` field). `start_time` is just an anchor date/time for the
 * recurrence to compute from — currently set to the Friday the team's
 * back from retreat.
 */
const dailySummarySchedule: Trigger<typeof DailySummaryWorkflow.definition> = {
  type: TriggerTypes.Scheduled,
  name: "Daily PR summary",
  description: "Posts the beginning-of-day PR summary on weekday mornings",
  workflow: `#/workflows/${DailySummaryWorkflow.definition.callback_id}`,
  inputs: {
    channel_id: { value: PR_CHANNEL_ID },
  },
  schedule: {
    start_time: "2026-10-02T13:00:00Z", // 9am EDT
    timezone: "America/New_York",
    frequency: {
      type: "weekly",
      on_days: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
      ],
      repeats_every: 1,
    },
  },
};

export default dailySummarySchedule;
