# PR Notifs

A Slack app (built on Slack's next-generation platform, Deno-based) that posts a
beginning-of-day summary to **#rad-eng-pull-requests**, flagging PRs that need
attention based on the team's emoji conventions:

- 👀 `eyes` — someone is looking at the PR
- ✅ `white_check_mark` — PR approved
- 🔄 `arrows_counterclockwise` — reviewer requested changes
- ❗ `exclamation` — high priority

Each weekday morning, the bot scans the channel for messages containing a
`github.com/.../pull/...` link and reports:

1. **Needs a first look** — PRs with no 👀 and no ✅ yet.
2. **Approved, ready to merge** — PRs with ✅ that GitHub confirms are still
   unmerged (nudges the person who posted the PR to merge it).
3. **Stale reviews** — PRs with 👀 but no ✅, where the 👀 reaction was first
   seen two or more daily checks ago (nudges whoever reacted 👀 to check back in
   or hand it off).
4. A fun stat calling out whoever kicked off the most new reviews that day.

Every item links back to the original Slack message via a permalink, so reacting
there updates the PR's tracked status for the next run.

The bot polls once a day (via a Slack **scheduled trigger**) rather than
listening to live events — see [How it works](#how-it-works) for what that means
for timing.

## Setup

### 1. Install the Slack CLI (already done if you're reading this in the repo)

See the [Quickstart Guide](https://api.slack.com/automation/quickstart) if you
need to install it.

### 2. Get a GitHub token

Create a GitHub Personal Access Token with read access to the repo(s) whose PRs
get posted in the channel (a fine-grained PAT scoped to just those repos is
preferable to a classic PAT with broad `repo` scope). This is only used to check
whether an approved PR has been merged.

### 3. Find the channel ID

In Slack, open **#rad-eng-pull-requests** → channel name → **View channel
details**, and scroll down to find the Channel ID (starts with `C`).

Paste it into `triggers/config.ts` as `PR_CHANNEL_ID`.

### 4. Run locally and set the GitHub token

```zsh
$ slack run
```

The first run will prompt you to create the triggers found in `triggers/` (the
scheduled daily summary and a manual test trigger) for your **local** app
install. Once it's running, set the token as an app-level environment variable
(in another terminal):

```zsh
$ slack env add GITHUB_TOKEN <your-token>
```

### 5. Try it

Post a message containing a `github.com/.../pull/...` link into the channel,
react to it with some of the emoji above, then run the **"Run PR summary now
(test)"** link trigger printed when `slack run` created triggers (or run
`slack trigger create --trigger-def triggers/manual_test_trigger.ts` to get the
link again). Confirm the posted summary looks right.

To see the 2-day "stale review" nudge without waiting two days, inspect and edit
the `PrTracking` datastore row's `first_seen_looking_date` directly:

```zsh
$ slack datastore query --datastore PrTracking
```

### 6. Deploy

```zsh
$ slack deploy
```

You'll be prompted to create the triggers again for the **deployed** version
(local and deployed triggers are separate). Set the GitHub token for the
deployed app too:

```zsh
$ slack env add GITHUB_TOKEN <your-token>
```

The scheduled trigger fires weekdays at 9am `America/New_York` — see
`triggers/daily_summary_schedule.ts` to change the time, days, or timezone.

## How it works

Because the bot only checks in once a day, review "staleness" is measured in
**poll-days**, not hours: the first daily check that sees a 👀 reaction on a PR
records that date, and the check that runs 2+ days after that (with the PR still
unapproved) is what triggers the stale-review nudge. This means the actual
elapsed time before a nudge is roughly 2–3 calendar days, not exactly 48 hours.

Similarly, the fun "reviewed N PRs today" stat only counts 👀 reactions that are
newly observed compared to the previous day's check — it can't know about
reactions added and removed within the same day, and won't have any history to
compare against for PRs first seen before the bot was deployed.

State (per-PR review status and per-person stats) lives in two
[Datastores](https://api.slack.com/automation/datastores):
`datastores/pr_tracking.ts` and `datastores/review_stats.ts`.

If your workspace uses different (e.g. custom) emoji for looking/approved,
update the `EMOJI_LOOKING`/`EMOJI_APPROVED` constants at the top of
`functions/check_prs.ts`.

## Project Structure

### `functions/check_prs.ts`

All the logic: reads channel history, updates PR tracking state, checks GitHub
for merge status, computes the fun stat, and posts the summary message.

### `workflows/daily_summary.ts`

Thin wrapper that runs `check_prs` as a single-step workflow.

### `triggers/`

- `config.ts` — shared `PR_CHANNEL_ID` constant.
- `daily_summary_schedule.ts` — the weekday 9am ET scheduled trigger.
- `manual_test_trigger.ts` — an on-demand Link trigger for testing; safe to
  remove once you trust the schedule.

### `datastores/`

- `pr_tracking.ts` — one row per PR post: review state, first-seen-looking date,
  merged flag, etc.
- `review_stats.ts` — one row per person: best single-day review count, for the
  "new record" fun stat.

## Testing

```zsh
$ deno task test
```

Runs `deno fmt --check`, `deno lint`, and `deno test` (see
`functions/check_prs_test.ts` for the mocked-fetch pattern used to test Slack
and GitHub API calls without hitting the network).

## Viewing Activity Logs

```zsh
$ slack activity --tail
```

## Future Improvements

**Auth: migrate from PAT to a GitHub App.** This bot currently authenticates to
GitHub with a personal access token (see `fetchGitHubMergedState` in
`functions/check_prs.ts`). That's fine for the current experiment stage, but a
GitHub App is the better long-term pattern for this kind of narrow, unattended,
read-only automation: it's scoped to an install rather than a person's account,
issues short-lived tokens, and doesn't break if whoever created the PAT leaves.
It's more setup (register an app, generate a private key, install it on the
relevant repo(s), sign a JWT and exchange it for an installation access token on
each run instead of reading a static token from env) so it's been deferred until
this graduates past experiment. See
[murmuration-rad/pr-notifs#1](https://github.com/murmuration-rad/pr-notifs/issues/1)
for the tracking issue. `fetchGitHubMergedState` is the only place GitHub auth
happens, so swapping it out later should be a self-contained change.

## Resources

- [Automation Overview](https://api.slack.com/automation)
- [CLI Quick Reference](https://api.slack.com/automation/cli/quick-reference)
- [Scheduled Triggers](https://api.slack.com/automation/triggers/scheduled)
- [Datastores](https://api.slack.com/automation/datastores)
