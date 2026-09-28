import { SlackFunctionTester } from "deno-slack-sdk/mod.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { stub } from "@std/testing/mock";
import CheckPrsFunction, {
  daysBetween,
  mapWithConcurrency,
  todayUtc,
} from "./check_prs.ts";

const { createContext } = SlackFunctionTester("check_prs");

const CHANNEL_ID = "C0123456789";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

Deno.test("daysBetween computes whole day differences", () => {
  assertEquals(daysBetween("2026-01-01", "2026-01-01"), 0);
  assertEquals(daysBetween("2026-01-01", "2026-01-03"), 2);
});

Deno.test("todayUtc returns a YYYY-MM-DD string", () => {
  assertStringIncludes(todayUtc(), "-");
  assertEquals(todayUtc().length, 10);
});

Deno.test("mapWithConcurrency preserves result order and caps concurrency", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;

  const results = await mapWithConcurrency([5, 4, 3, 2, 1, 0], 2, async (n) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, n));
    concurrent--;
    return n * 10;
  });

  assertEquals(results, [50, 40, 30, 20, 10, 0]);
  assertEquals(maxConcurrent <= 2, true);
});

Deno.test("flags a brand new PR post as needing a first look", async () => {
  using _stubFetch = stub(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, options);

      if (request.url === "https://slack.com/api/conversations.history") {
        return jsonResponse({
          ok: true,
          messages: [
            {
              ts: "1000.0001",
              user: "U_AUTHOR",
              text: "New PR: https://github.com/acme/widgets/pull/42",
            },
          ],
        });
      }
      if (request.url === "https://slack.com/api/apps.datastore.get") {
        const body = await request.formData();
        return jsonResponse({
          ok: true,
          datastore: body.get("datastore"),
          item: {},
        });
      }
      if (request.url === "https://slack.com/api/chat.getPermalink") {
        return jsonResponse({
          ok: true,
          permalink: "https://acme.slack.com/archives/C0123456789/p10000001",
        });
      }
      if (request.url === "https://slack.com/api/apps.datastore.put") {
        const body = await request.formData();
        return jsonResponse({
          ok: true,
          datastore: body.get("datastore"),
          item: JSON.parse(body.get("item") as string),
        });
      }
      if (request.url === "https://slack.com/api/chat.postMessage") {
        return jsonResponse({ ok: true, ts: "2000.0001" });
      }
      throw new Error(`Unexpected fetch to ${request.url}`);
    },
  );

  const inputs = { channel_id: CHANNEL_ID };
  const { outputs, error } = await CheckPrsFunction(createContext({ inputs }));

  assertEquals(error, undefined);
  assertEquals(outputs?.summary_ts, "2000.0001");
});

Deno.test("flags a stale review once 2+ days have passed since first 👀", async () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  let postedText = "";

  using _stubFetch = stub(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, options);

      if (request.url === "https://slack.com/api/conversations.history") {
        return jsonResponse({
          ok: true,
          messages: [
            {
              ts: "1000.0002",
              user: "U_AUTHOR",
              text: "New PR: https://github.com/acme/widgets/pull/7",
              reactions: [
                { name: "eyes", users: ["U_REVIEWER"], count: 1 },
              ],
            },
          ],
        });
      }
      if (request.url === "https://slack.com/api/apps.datastore.get") {
        const body = await request.formData();
        if (body.get("datastore") === "PrTracking") {
          return jsonResponse({
            ok: true,
            datastore: "PrTracking",
            item: {
              pr_key: `${CHANNEL_ID}-1000.0002`,
              channel_id: CHANNEL_ID,
              message_ts: "1000.0002",
              permalink:
                "https://acme.slack.com/archives/C0123456789/p10000002",
              github_owner: "acme",
              github_repo: "widgets",
              pr_number: 7,
              author_user_id: "U_AUTHOR",
              has_looking: true,
              has_approved: false,
              first_seen_looking_date: twoDaysAgo,
              looking_user_ids: ["U_REVIEWER"],
              merged: false,
              last_checked_date: twoDaysAgo,
            },
          });
        }
        return jsonResponse({ ok: true, datastore: "ReviewStats", item: {} });
      }
      if (request.url === "https://slack.com/api/apps.datastore.put") {
        const body = await request.formData();
        return jsonResponse({
          ok: true,
          datastore: body.get("datastore"),
          item: JSON.parse(body.get("item") as string),
        });
      }
      if (request.url === "https://slack.com/api/chat.postMessage") {
        const body = await request.formData();
        postedText = (JSON.parse(body.get("blocks") as string))[0].text.text;
        return jsonResponse({ ok: true, ts: "2000.0002" });
      }
      throw new Error(`Unexpected fetch to ${request.url}`);
    },
  );

  const inputs = { channel_id: CHANNEL_ID };
  const { error } = await CheckPrsFunction(createContext({ inputs }));

  assertEquals(error, undefined);
  assertStringIncludes(postedText, "<@U_REVIEWER>");
  assertStringIncludes(postedText, "Stale reviews* (1)");
});

Deno.test("nudges the author when approved but GitHub says it's not merged yet", async () => {
  Deno.env.set("GITHUB_TOKEN", "test-token");
  let postedText = "";

  using _stubFetch = stub(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, options);

      if (request.url === "https://slack.com/api/conversations.history") {
        return jsonResponse({
          ok: true,
          messages: [
            {
              ts: "1000.0003",
              user: "U_AUTHOR",
              text: "New PR: https://github.com/acme/widgets/pull/9",
              reactions: [
                { name: "white_check_mark", users: ["U_REVIEWER"], count: 1 },
              ],
            },
          ],
        });
      }
      if (request.url === "https://slack.com/api/apps.datastore.get") {
        const body = await request.formData();
        return jsonResponse({
          ok: true,
          datastore: body.get("datastore"),
          item: {},
        });
      }
      if (request.url === "https://slack.com/api/chat.getPermalink") {
        return jsonResponse({
          ok: true,
          permalink: "https://acme.slack.com/archives/C0123456789/p10000003",
        });
      }
      if (request.url === "https://api.github.com/repos/acme/widgets/pulls/9") {
        assertEquals(request.headers.get("Authorization"), "Bearer test-token");
        return jsonResponse({ merged: false, state: "open" });
      }
      if (request.url === "https://slack.com/api/apps.datastore.put") {
        const body = await request.formData();
        return jsonResponse({
          ok: true,
          datastore: body.get("datastore"),
          item: JSON.parse(body.get("item") as string),
        });
      }
      if (request.url === "https://slack.com/api/chat.postMessage") {
        const body = await request.formData();
        postedText = (JSON.parse(body.get("blocks") as string))[0].text.text;
        return jsonResponse({ ok: true, ts: "2000.0003" });
      }
      throw new Error(`Unexpected fetch to ${request.url}`);
    },
  );

  const inputs = { channel_id: CHANNEL_ID };
  const { error } = await CheckPrsFunction(createContext({ inputs }));

  assertEquals(error, undefined);
  assertStringIncludes(postedText, "Approved, ready to merge* (1)");
  assertStringIncludes(postedText, "<@U_AUTHOR> go ahead and merge!");

  Deno.env.delete("GITHUB_TOKEN");
});

Deno.test("excludes a PR from the report once GitHub confirms it's merged", async () => {
  Deno.env.set("GITHUB_TOKEN", "test-token");
  let postedText = "";

  using _stubFetch = stub(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, options);

      if (request.url === "https://slack.com/api/conversations.history") {
        return jsonResponse({
          ok: true,
          messages: [
            {
              ts: "1000.0004",
              user: "U_AUTHOR",
              text: "New PR: https://github.com/acme/widgets/pull/10",
              reactions: [
                { name: "white_check_mark", users: ["U_REVIEWER"], count: 1 },
              ],
            },
          ],
        });
      }
      if (request.url === "https://slack.com/api/apps.datastore.get") {
        const body = await request.formData();
        return jsonResponse({
          ok: true,
          datastore: body.get("datastore"),
          item: {},
        });
      }
      if (request.url === "https://slack.com/api/chat.getPermalink") {
        return jsonResponse({
          ok: true,
          permalink: "https://acme.slack.com/archives/C0123456789/p10000004",
        });
      }
      if (
        request.url === "https://api.github.com/repos/acme/widgets/pulls/10"
      ) {
        return jsonResponse({ merged: true, state: "closed" });
      }
      if (request.url === "https://slack.com/api/apps.datastore.put") {
        const body = await request.formData();
        return jsonResponse({
          ok: true,
          datastore: body.get("datastore"),
          item: JSON.parse(body.get("item") as string),
        });
      }
      if (request.url === "https://slack.com/api/chat.postMessage") {
        const body = await request.formData();
        postedText = (JSON.parse(body.get("blocks") as string))[0].text.text;
        return jsonResponse({ ok: true, ts: "2000.0004" });
      }
      throw new Error(`Unexpected fetch to ${request.url}`);
    },
  );

  const inputs = { channel_id: CHANNEL_ID };
  const { error } = await CheckPrsFunction(createContext({ inputs }));

  assertEquals(error, undefined);
  assertStringIncludes(postedText, "Approved, ready to merge* (0)");

  Deno.env.delete("GITHUB_TOKEN");
});
