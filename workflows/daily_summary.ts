import { DefineWorkflow, Schema } from "deno-slack-sdk/mod.ts";
import { CheckPrsFunctionDefinition } from "../functions/check_prs.ts";

/**
 * Runs the PR check-and-summarize function. Kept as a thin wrapper so the
 * function itself stays independently testable, and so future steps (e.g.
 * a Slack-native function) can be added around it if needed.
 */
const DailySummaryWorkflow = DefineWorkflow({
  callback_id: "daily_summary",
  title: "Post daily PR summary",
  description: "Scans the PR channel and posts the beginning-of-day summary",
  input_parameters: {
    properties: {
      channel_id: {
        type: Schema.slack.types.channel_id,
      },
    },
    required: ["channel_id"],
  },
});

DailySummaryWorkflow.addStep(CheckPrsFunctionDefinition, {
  channel_id: DailySummaryWorkflow.inputs.channel_id,
});

export default DailySummaryWorkflow;
