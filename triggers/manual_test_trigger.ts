import type { Trigger } from "deno-slack-sdk/types.ts";
import { TriggerTypes } from "deno-slack-api/mod.ts";
import DailySummaryWorkflow from "../workflows/daily_summary.ts";
import { PR_CHANNEL_ID } from "./config.ts";

/**
 * A Link trigger for running the daily PR check on demand while developing
 * (`slack trigger create` prints a shortcut URL you can click any time,
 * without waiting for the scheduled trigger to fire). Safe to remove once
 * you're confident in the scheduled trigger.
 */
const manualTestTrigger: Trigger<typeof DailySummaryWorkflow.definition> = {
  type: TriggerTypes.Shortcut,
  name: "Run PR summary now (test)",
  description: "Manually runs the daily PR summary check, for testing",
  workflow: `#/workflows/${DailySummaryWorkflow.definition.callback_id}`,
  inputs: {
    channel_id: { value: PR_CHANNEL_ID },
  },
};

export default manualTestTrigger;
