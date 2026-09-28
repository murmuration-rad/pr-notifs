import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";
import type PrTrackingDatastore from "../datastores/pr_tracking.ts";
import type ReviewStatsDatastore from "../datastores/review_stats.ts";

// Emoji short names the team uses to track PR review status. If your
// workspace uses different (e.g. custom) emoji for these, update the names
// below to match.
const EMOJI_LOOKING = "eyes"; // 👀
const EMOJI_APPROVED = "white_check_mark"; // ✅
// EMOJI_CHANGES_REQUESTED (🔄, "arrows_counterclockwise") and
// EMOJI_HIGH_PRIORITY (❗, "exclamation") are tracked by the team but not
// currently used in any of the summary rules below.

// A 👀 reaction has to have been first observed at least this many daily
// checks ago (with no ✅ yet) before we nudge the reviewer.
const STALE_REVIEW_DAYS = 2;

// How far back into channel history to look each run.
const HISTORY_LIMIT = 200;

// How many PR messages to process concurrently. Each one does several
// sequential Slack/GitHub API calls, so processing a busy channel's backlog
// one message at a time can take long enough to trip local dev's websocket
// idle timeout. Capped (rather than unbounded) to stay polite to API rate
// limits.
const PR_PROCESSING_CONCURRENCY = 5;

const PR_LINK_PATTERN = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

export const CheckPrsFunctionDefinition = DefineFunction({
  callback_id: "check_prs",
  title: "Check PRs and post daily summary",
  description:
    "Scans the PR channel for tracked pull requests, updates their review state, and posts the beginning-of-day summary",
  source_file: "functions/check_prs.ts",
  input_parameters: {
    properties: {
      channel_id: {
        type: Schema.slack.types.channel_id,
        description: "Channel to scan and post the summary in",
      },
    },
    required: ["channel_id"],
  },
  output_parameters: {
    properties: {
      summary_ts: {
        type: Schema.types.string,
        description: "Timestamp of the posted summary message",
      },
    },
    required: [],
  },
});

type PrItem = {
  pr_key: string;
  channel_id: string;
  message_ts: string;
  permalink: string;
  github_owner: string;
  github_repo: string;
  pr_number: number;
  author_user_id: string;
  has_looking: boolean;
  has_approved: boolean;
  github_approved: boolean;
  first_seen_looking_date: string;
  looking_user_ids: string[];
  merged: boolean;
  last_checked_date: string;
};

type SlackReaction = { name: string; users: string[]; count: number };

type SlackMessage = {
  ts: string;
  text?: string;
  user?: string;
  thread_ts?: string;
  reactions?: SlackReaction[];
};

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysBetween(earlierDate: string, laterDate: string): number {
  const ms = Date.parse(laterDate) - Date.parse(earlierDate);
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function reactionUsers(message: SlackMessage, emojiName: string): string[] {
  return message.reactions?.find((r) => r.name === emojiName)?.users ?? [];
}

type PrLinkOccurrence = {
  message: SlackMessage;
  owner: string;
  repo: string;
  prNumber: number;
};

// A single message can link multiple PRs (e.g. a batch "N of mine open for
// review" post). Each linked PR is tracked and merge-checked independently,
// but they all share the same underlying Slack message, so a 👀/✅ on that
// message is currently read as applying to every PR linked in it — Slack
// has no way to react to just one link within a message. Revisit if this
// stops being a good enough approximation (e.g. splitting batch posts into
// one message per PR, or requiring some other per-PR signal).
function extractPrLinks(message: SlackMessage): PrLinkOccurrence[] {
  if (!message.text) return [];

  const seen = new Set<string>();
  const occurrences: PrLinkOccurrence[] = [];
  for (const match of message.text.matchAll(PR_LINK_PATTERN)) {
    const [, owner, repo, prNumberStr] = match;
    const prNumber = parseInt(prNumberStr, 10);
    const dedupeKey = `${owner}/${repo}/${prNumber}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    occurrences.push({ message, owner, repo, prNumber });
  }
  return occurrences;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

// Auth: uses a personal access token for now (fine for the experiment
// stage). A GitHub App is the recommended long-term pattern for this kind
// of unattended read-only automation — see the "Future Improvements"
// section in the README. This function is the only place GitHub auth
// happens, so it should be a self-contained swap later.
export async function fetchGitHubMergedState(
  owner: string,
  repo: string,
  prNumber: number,
  token: string | undefined,
): Promise<boolean | undefined> {
  if (!token) {
    console.error("GITHUB_TOKEN is not set; skipping merge check");
    return undefined;
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "pr-notifs-slack-bot",
        },
      },
    );
    if (!res.ok) {
      console.error(
        `GitHub API returned ${res.status} for ${owner}/${repo}#${prNumber}`,
      );
      return undefined;
    }
    const body = await res.json();
    return body.merged === true;
  } catch (err) {
    console.error(`GitHub API request failed: ${err}`);
    return undefined;
  }
}

type GitHubReview = { user?: { login?: string }; state?: string };

// A message linking multiple PRs shares one set of Slack reactions, so a ✅
// on the message doesn't tell us which specific linked PR was actually
// approved (see the README's "How it works" section / issue #2). This asks
// GitHub for each PR's real review state instead, which has no such
// ambiguity, and uses it (not the shared Slack reaction) to decide
// "approved, ready to merge".
export async function fetchGitHubApprovalState(
  owner: string,
  repo: string,
  prNumber: number,
  token: string | undefined,
): Promise<boolean | undefined> {
  if (!token) {
    console.error("GITHUB_TOKEN is not set; skipping approval check");
    return undefined;
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "pr-notifs-slack-bot",
        },
      },
    );
    if (!res.ok) {
      console.error(
        `GitHub API returned ${res.status} for ${owner}/${repo}#${prNumber} reviews`,
      );
      return undefined;
    }
    const reviews = await res.json() as GitHubReview[];

    // Reviews come back oldest-first, and GitHub supersedes each reviewer's
    // earlier review with their later one — keep only the latest verdict
    // per reviewer.
    const latestStateByReviewer = new Map<string, string>();
    for (const review of reviews) {
      const reviewerId = review.user?.login;
      if (!reviewerId || !review.state || review.state === "COMMENTED") {
        continue;
      }
      latestStateByReviewer.set(reviewerId, review.state);
    }

    const states = [...latestStateByReviewer.values()];
    const hasApproval = states.includes("APPROVED");
    const hasOutstandingChangesRequested = states.includes(
      "CHANGES_REQUESTED",
    );
    return hasApproval && !hasOutstandingChangesRequested;
  } catch (err) {
    console.error(`GitHub API request failed: ${err}`);
    return undefined;
  }
}

export default SlackFunction(
  CheckPrsFunctionDefinition,
  async ({ inputs, client, env }) => {
    const channelId = inputs.channel_id;
    const today = todayUtc();
    const githubToken = env["GITHUB_TOKEN"];

    const historyResponse = await client.conversations.history({
      channel: channelId,
      limit: HISTORY_LIMIT,
    });
    if (!historyResponse.ok) {
      return {
        error: `Failed to read channel history: ${historyResponse.error}`,
      };
    }

    const messages = (historyResponse.messages ?? []) as SlackMessage[];

    const needsFirstLook: PrItem[] = [];
    const approvedNotMerged: PrItem[] = [];
    const staleReview: { item: PrItem; reviewers: string[] }[] = [];
    const todaysLookCounts = new Map<string, number>();

    const prOccurrences = messages.flatMap(extractPrLinks);

    const processed = await mapWithConcurrency(
      prOccurrences,
      PR_PROCESSING_CONCURRENCY,
      async ({ message, owner, repo, prNumber }): Promise<
        { item: PrItem; newLookerIds: string[] } | null
      > => {
        try {
          const prKey = `${channelId}-${message.ts}-${prNumber}`;

          const getResponse = await client.apps.datastore.get<
            typeof PrTrackingDatastore.definition
          >({
            datastore: "PrTracking",
            id: prKey,
          });
          if (!getResponse.ok) {
            console.error(
              `Failed to read PR tracking record for ${prKey}: ${getResponse.error}`,
            );
            return null;
          }

          const existing = getResponse.item as Partial<PrItem>;
          if (existing.merged === true) return null;

          const isNewRecord = !existing.pr_key;

          let permalink = existing.permalink;
          if (!permalink) {
            const permalinkResponse = await client.chat.getPermalink({
              channel: channelId,
              message_ts: message.ts,
            });
            permalink = permalinkResponse.ok
              ? (permalinkResponse.permalink as string)
              : "";
          }

          const lookingUsersNow = reactionUsers(message, EMOJI_LOOKING);
          const hasApprovedNow =
            reactionUsers(message, EMOJI_APPROVED).length > 0;
          const previousLookers = existing.looking_user_ids ?? [];

          const newLookerIds = isNewRecord
            ? []
            : lookingUsersNow.filter((userId) =>
              !previousLookers.includes(userId)
            );

          const firstSeenLookingDate = lookingUsersNow.length > 0
            ? (existing.first_seen_looking_date || today)
            : (existing.first_seen_looking_date ?? "");

          // Always check GitHub's actual merge status, not just when
          // approved in Slack — a PR can get merged without ever picking up
          // a 👀 or ✅ reaction (e.g. merged directly on GitHub), and we'd
          // otherwise keep reporting it as needing a first look forever.
          const mergedState = await fetchGitHubMergedState(
            owner,
            repo,
            prNumber,
            githubToken,
          );
          const merged = mergedState === true;

          // Skip the extra API call once merged — it'll be excluded from
          // every category below regardless of approval state.
          const githubApproved = merged
            ? false
            : (await fetchGitHubApprovalState(
              owner,
              repo,
              prNumber,
              githubToken,
            )) === true;

          const item: PrItem = {
            pr_key: prKey,
            channel_id: channelId,
            message_ts: message.ts,
            permalink: permalink ?? "",
            github_owner: owner,
            github_repo: repo,
            pr_number: prNumber,
            author_user_id: existing.author_user_id || message.user || "",
            has_looking: lookingUsersNow.length > 0,
            has_approved: hasApprovedNow,
            github_approved: githubApproved,
            first_seen_looking_date: firstSeenLookingDate,
            looking_user_ids: lookingUsersNow,
            merged,
            last_checked_date: today,
          };

          const putResponse = await client.apps.datastore.put<
            typeof PrTrackingDatastore.definition
          >({
            datastore: "PrTracking",
            item,
          });
          if (!putResponse.ok) {
            console.error(
              `Failed to save PR tracking record for ${prKey}: ${putResponse.error}`,
            );
            return null;
          }

          return { item, newLookerIds };
        } catch (err) {
          console.error(
            `Failed to process ${owner}/${repo}#${prNumber} from message ${message.ts}: ${err}`,
          );
          return null;
        }
      },
    );

    for (const result of processed) {
      if (!result) continue;
      const { item, newLookerIds } = result;

      for (const userId of newLookerIds) {
        todaysLookCounts.set(userId, (todaysLookCounts.get(userId) ?? 0) + 1);
      }

      if (item.merged) continue;

      // Categorization uses GitHub's real approval state (item.github_approved),
      // not the shared Slack ✅ reaction (item.has_approved) — see the
      // fetchGitHubApprovalState comment above for why.
      if (!item.has_looking && !item.github_approved) {
        needsFirstLook.push(item);
      }
      if (item.github_approved) {
        approvedNotMerged.push(item);
      }
      if (
        item.has_looking && !item.github_approved &&
        item.first_seen_looking_date &&
        daysBetween(item.first_seen_looking_date, today) >=
          STALE_REVIEW_DAYS
      ) {
        staleReview.push({ item, reviewers: item.looking_user_ids });
      }
    }

    // Fun stat: whoever started reviewing the most new PRs today.
    let funStatLine = "No new reviews kicked off today — be the first! :eyes:";
    if (todaysLookCounts.size > 0) {
      let topUser = "";
      let topCount = 0;
      for (const [userId, count] of todaysLookCounts) {
        if (count > topCount) {
          topUser = userId;
          topCount = count;
        }
      }

      const statsResponse = await client.apps.datastore.get<
        typeof ReviewStatsDatastore.definition
      >({
        datastore: "ReviewStats",
        id: topUser,
      });
      if (!statsResponse.ok) {
        console.error(`Failed to read review stats: ${statsResponse.error}`);
      } else {
        const existingStats = statsResponse.item as {
          best_day_count?: number;
          best_day_date?: string;
        };
        const bestDayCount = existingStats.best_day_count ?? 0;
        const isNewRecord = topCount > bestDayCount;

        const updatedStats = {
          user_id: topUser,
          best_day_count: isNewRecord ? topCount : bestDayCount,
          best_day_date: isNewRecord
            ? today
            : (existingStats.best_day_date ?? today),
          last_count: topCount,
        };
        const putStatsResponse = await client.apps.datastore.put<
          typeof ReviewStatsDatastore.definition
        >({
          datastore: "ReviewStats",
          item: updatedStats,
        });
        if (!putStatsResponse.ok) {
          console.error(
            `Failed to save review stats: ${putStatsResponse.error}`,
          );
        }

        const prWord = topCount === 1 ? "PR" : "PRs";
        funStatLine = isNewRecord
          ? `:tada: <@${topUser}> reviewed ${topCount} ${prWord} today — new personal record!`
          : `:mag: <@${topUser}> reviewed ${topCount} ${prWord} today.`;
      }
    }

    function headerBlock(text: string) {
      return {
        type: "header",
        text: { type: "plain_text", text, emoji: true },
      };
    }

    function sectionBlock(text: string) {
      return { type: "section", text: { type: "mrkdwn", text } };
    }

    const blocks = [
      headerBlock(":sunrise: Good morning! Here's today's PR status"),
      headerBlock(
        `:${EMOJI_LOOKING}: Needs a first look (${needsFirstLook.length})`,
      ),
      sectionBlock(
        needsFirstLook.length
          ? needsFirstLook.map((i) =>
            `• <${i.permalink}|PR #${i.pr_number}> — no reviewer yet`
          ).join("\n")
          : "_Nothing waiting — nice!_",
      ),
      headerBlock(
        `:${EMOJI_APPROVED}: Approved, ready to merge (${approvedNotMerged.length})`,
      ),
      sectionBlock(
        approvedNotMerged.length
          ? approvedNotMerged.map((i) =>
            `• <${i.permalink}|PR #${i.pr_number}> — <@${i.author_user_id}> go ahead and merge!`
          ).join("\n")
          : "_Nothing waiting on a merge._",
      ),
      headerBlock(
        `:arrows_counterclockwise: Stale reviews (${staleReview.length})`,
      ),
      sectionBlock(
        staleReview.length
          ? staleReview.map(({ item, reviewers }) =>
            `• <${item.permalink}|PR #${item.pr_number}> — ${
              reviewers.map((r) => `<@${r}>`).join(", ")
            } still looking, or should someone else take a pass?`
          ).join("\n")
          : "_No reviews stuck._",
      ),
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: funStatLine }] },
    ];

    const postResponse = await client.chat.postMessage({
      channel: channelId,
      text: "Beginning of day PR summary",
      unfurl_links: false,
      unfurl_media: false,
      blocks,
    });
    if (!postResponse.ok) {
      return {
        error: `Failed to post summary message: ${postResponse.error}`,
      };
    }

    return { outputs: { summary_ts: postResponse.ts as string } };
  },
);
