# OLX Parser Bot

Cloudflare Worker that watches OLX search results and broadcasts new ads to every Telegram chat the bot is in.

- Poll cron `*/5 * * * *`, retention cron `0 3 * * *`
- Dedup key is OLX's own `ad.id` — a bumped ad is never re-sent
- The first sweep of a new search is silent: everything found is recorded, only the owner gets a report

## How a search is resolved

An OLX search page embeds its listing state in `window.__PRERENDERED_STATE__`. `/add` streams the page,
stops reading the moment it finds the listing params, and turns them into a plain REST URL:

```
https://www.olx.ua/api/v1/offers?offset=0&limit=50&query=…&category_id=…&currency=UAH&sort_by=created_at:desc
```

That URL is stored once. Polling never touches HTML again — it just reads ~75 KB of JSON, which needs no
auth, no cookies and no session.

The GraphQL endpoint at `/apigateway/graphql` is deliberately not used: it serves *observed* ads rather than
search results, and its bearer token expires after 15 minutes.

## Setup

```bash
npm install

# 1. Database — copy the printed database_id into wrangler.jsonc
npx wrangler d1 create olx-parser-bot
npm run migrate:local
npm run migrate:remote

# 2. Secrets
npx wrangler secret put BOT_TOKEN       # from @BotFather
npx wrangler secret put WEBHOOK_SECRET  # any random string
npx wrangler secret put OWNER_CHAT_ID   # numeric chat id, or several: 111,222

# 3. Deploy
npm run deploy

# 4. Point Telegram at the worker
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://<worker>.workers.dev/webhook",
    "secret_token": "<WEBHOOK_SECRET>",
    "allowed_updates": ["message", "channel_post", "my_chat_member"]
  }'
```

Then add the bot to a channel **as an administrator** (or to a group) and check `/chats`.

**How a chat becomes a broadcast target**

| Chat type | How it registers |
|---|---|
| Channel | Add the bot as an admin with posting rights — `my_chat_member` does the rest |
| Group / supergroup | Add the bot — `my_chat_member` does the rest |
| Forum topic | Add the bot, then send `/subscribe` **inside the topic** |
| Private | `/subscribe` only. `/start` deliberately does not register it |

Telegram forces `/start` before it even shows an input field, so it cannot stand for consent to receive the
feed. Topics are the other special case: `message_thread_id` is required on every send or Telegram drops the
message into "General", and that id is only observable from a message posted inside the topic — never from
`my_chat_member`. Re-running `/subscribe` in a different topic moves the feed there.

## Commands

Owner-only. Everyone else is ignored without a reply.

`OWNER_CHAT_ID` holds one id or several separated by commas. Authorisation is on the **sender's** user id, so
an owner can command the bot from anywhere — a DM, a group, a topic — while other members of that group are
ignored. The same ids double as the destination for initialisation and failure reports, which works because a
personal chat id equals the user's own id. Channel posts have no sender and are never treated as commands.

To hand the bot over, re-run `wrangler secret put OWNER_CHAT_ID` with the full list; the secret is replaced
wholesale, so include yourself if you want to stay.

| Command | Effect |
|---|---|
| `/add <url>` | Add a search — an OLX results page, or an `api/v1/offers` URL directly |
| `/list` | Searches with status, last run and failure count |
| `/rm <id>` | Delete a search and its history |
| `/pause <id>` / `/resume <id>` | Toggle polling; resume clears the failure counter |
| `/test <id>` | Render the newest ad into the current chat, writing nothing to history |
| `/chats` | Broadcast targets |
| `/subscribe` / `/unsubscribe` | Opt the current chat in or out of the broadcast |
| `/status` | Counts of searches, chats and history rows |

## Tests

```bash
npm test            # 81 tests, no network
npm run test:live   # hits olx.ua: resolve → API → render
npm run typecheck
```

`npm test` covers rendering against a captured `/api/v1/offers` response, the page-state resolver,
deduplication, silent initialisation, subrequest-budget exhaustion, Telegram `429`, a kicked chat,
forum-topic routing, webhook auth and access control, and history retention.

The fixture in `test/fixtures/offers.json` is a real OLX response with seller identities pseudonymised.

Local run:

```bash
npm run dev
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

## Limits this design works within

Cloudflare Workers Free allows 50 subrequests per invocation. A tick spends one per search plus one per
`(ad × chat)` send, and stops before it would start a broadcast it cannot finish — undelivered ads stay
unrecorded and go out on the next tick. `seen_ads` is only written **after** a successful send, so a crash
mid-broadcast costs a duplicate rather than a lost ad.
