# OLX Parser Bot

Cloudflare Worker that watches OLX search results and broadcasts new ads to every Telegram chat the bot is in.

- Poll cron `*/5 * * * *`, retention cron `0 3 * * *`
- Dedup key is OLX's own `ad.id`, and it is global — a bumped ad is never re-sent, and an ad matched by
  two overlapping searches goes out once, from whichever search claims it first
- The first sweep of a new search is silent: everything found is recorded, only the owner gets a report
- Ads from throwaway seller accounts are filtered out before broadcast — see [Seller trust](#seller-trust)
- Ads that name no price are filtered out too — see [Price](#price)

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

## Seller trust

OLX exposes no rating in `/api/v1/offers` — the score shown on an ad page comes from a separate service,
one request per seller, which does not fit a 50-subrequest tick. So the filter uses only what the listing
already carries and costs nothing extra:

| Var | Default | Effect |
|---|---|---|
| `MIN_SELLER_AGE_DAYS` | `30` | Skip ads from accounts registered more recently than this. `0` turns the check off |
| `REQUIRE_SAFEDEAL` | `false` | Skip ads that do not offer OLX Доставка |

Account age is the one signal in the payload that separates a throwaway scam profile from an ordinary
seller. OLX Доставка means a buyer can pay through OLX instead of transferring money upfront, but it only
exists for shippable goods — switching `REQUIRE_SAFEDEAL` on empties a property, jobs or services search
outright, which is why it ships off.

A seller whose registration date OLX omits **passes**. The filter is there to trim spam, and a change in
OLX's payload shape must not silently mute the feed. A rejected ad is left unrecorded rather than consumed;
the age cutoff is what eventually retires it.

The first sweep of a new search still records everything, however untrusted — it broadcasts nothing anyway.

## Price

| Var | Default | Effect |
|---|---|---|
| `REQUIRE_PRICE` | `true` | Skip ads that name no price. Set to `false` to receive them |

OLX has two different things that both read as "Договірна". One is a figure the seller marks as
haggle-friendly: `value` holds the number and `negotiable` (or `arranged`) is just a flag next to it. The
other is an ad with no number at all — `value` is `null`, and so are exchanges and giveaways. Only the second
kind is skipped; a negotiable price goes out with its figure and a `(договірна)` note after it.

The filter reads `value`, never the label, so a wording change on OLX's side cannot turn a priced ad into a
skipped one. A rejected ad is left unrecorded rather than consumed, exactly as with seller trust, and the
first sweep of a new search still records it.

## Private sellers only

| Var | Default | Effect |
|---|---|---|
| `ALLOW_BUSINESS_ADS` | `false` | Whether ads from business accounts go out |

OLX makes a seller pick **Приватна особа** or **Бізнес** when posting, and returns the answer as `business`
on every offer. Nothing else in the payload substitutes for it: most business ads carry no shop slug and an
empty `company_name`, so `shop.subdomain` would miss them. Confirmed against OLX's own `owner_type` filter —
`owner_type=private` returns `business: false` for every result, `owner_type=business` returns `true`.

Unlike the other filters this one is flipped at runtime with `/business on|off`, which writes to the
`settings` table. The row outranks `ALLOW_BUSINESS_ADS` from then on; the var is only the bootstrap value.
A rejected ad is left unrecorded rather than consumed, so flipping the switch back makes it eligible again
while it is still inside the age cutoff.

The filter runs after OLX has already picked the 50 newest offers, so in a category flooded with shop stock
a fresh private ad can fall outside that window and never be seen. Narrowing the search — by category, price
or region — is the fix; filtering server-side via `owner_type` would need every stored `api_url` rewritten.

## Searches for one person only

`/add-for-me` adds a search whose ads reach **private chats only** — a personal watchlist that a shared group
is not woken by. The choice is stored on the source (`sources.private_only`), so it holds for every later
tick, and `/list` marks such a search with 👤. The group window above is irrelevant to it: a private chat is
always open, so an `/add-for-me` feed effectively runs round the clock.

Deduplication is global, and that has a consequence worth knowing. When a `/add-for-me` search and an
ordinary one both match the same ad, whichever the tick reaches first claims it — and if that is the
private-only search, **the group never sees that ad**. Claims are per ad, not per chat. Keep the two kinds of
search from overlapping if the group's feed matters.

`api_url` is unique, so `/add-for-me` on a search that already exists reports it instead of switching the
flag: silently moving a group's feed is worse than saying `/rm <id>` and adding it again.

## Quiet hours for groups

| Var | Default | Effect |
|---|---|---|
| `GROUP_HOURS` | `9-23` | When groups and channels accept ads, in `TIMEZONE`. `off` = round the clock |

A group or channel is a shared space, so it keeps daytime hours; a **private chat is one person's own feed
and is never held back**. The window is half-open — at `9-23` the last ad of the day lands at 22:59 — and one
whose end is below its start wraps past midnight, so `22-6` is a valid night window. `/hours` sets it at
runtime.

The window filters the broadcast targets, not the ads. When every subscribed chat is closed nothing is
claimed, so the ads simply wait for the next tick inside the window — provided they are still in the newest
50 offers and inside `MAX_AD_AGE_HOURS`. When a private chat is subscribed alongside a closed group the ad
goes out to the private chat and is claimed there, and **the group does not get it later**: delivery is
tracked per ad, not per chat. A new search still initialises silently while every chat is closed.

## Blocked sellers

| Var | Default | Effect |
|---|---|---|
| `BLOCKED_SELLERS` | `retromagaz` | Sellers whose ads never go out, separated by commas |

An entry is either a shop slug — the `retromagaz` of `retromagaz.olx.ua` — or a numeric OLX account id,
which is how a private seller with no shop page is named. Matching is case-insensitive and, as with the
other filters, a rejected ad is left unrecorded rather than consumed.

`/block` and `/unblock` edit the list at runtime. The first `/block` starts from the set currently in force —
the env var, until a row exists — so nothing the var names is silently unblocked. From then on the row
replaces the var outright, an empty row included: to go back to the var, `/unblock` is not enough, the row
has to be deleted from the `settings` table.

## When OLX fails

A failed sweep is sorted by who is at fault. An OLX `5xx`, an anti-bot `403`, a `408`/`429`, a timeout or an
HTML page where JSON was due is OLX having a bad moment: the search is **never disabled** for it. Its next poll
is pushed out instead — 5, 10, 20, 40 minutes, then every `MAX_BACKOFF_MINUTES` (60) — so an outage costs a
few subrequests, and the first successful sweep puts the search back on the normal five-minute cycle. Owners
hear about it once, when the failures in a row reach `MAX_FAILURES`, and once more when it recovers; `/list`
shows when the next attempt is due.

A `400`, `404` or `410` means the search URL itself is dead. That disables the search after `MAX_FAILURES`
in a row, as before, and needs `/resume` or `/rm`.

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
| `/add-for-me <url>` | The same, but its ads reach private chats only |
| `/list` | Searches with status, last run, failure count and next retry; 👤 marks a private-only one |
| `/rm <id>` | Delete a search and its history |
| `/pause <id>` / `/resume <id>` | Toggle polling; resume clears the failure counter |
| `/test <id>` | Render the newest ad into the current chat, writing nothing to history |
| `/business [on\|off]` | Ads from business accounts; no argument reports the current state |
| `/hours [9-23\|off]` | When groups and channels receive ads; no argument reports the window |
| `/blocked` | The blocklist in force |
| `/block <slug\|id>` | Block a seller; several at once are accepted |
| `/unblock <slug\|id>` | Unblock a seller |
| `/chats` | Broadcast targets |
| `/subscribe` / `/unsubscribe` | Opt the current chat in or out of the broadcast |
| `/status` | Counts of searches, chats and history rows, plus the runtime settings |

## Tests

```bash
npm test            # 234 tests, no network
npm run test:live   # hits olx.ua: resolve → API → render
npm run typecheck
```

`npm test` covers rendering against a captured `/api/v1/offers` response, the page-state resolver,
deduplication across searches, claim contention, silent initialisation, the seller-trust, price and
private-seller filters, the group window, private-only searches, the runtime settings and the commands that
write them, subrequest-budget exhaustion, OLX outages with backoff and self-recovery, Telegram `429`, a kicked chat, forum-topic routing, webhook auth
and access control, and history retention.

The fixture in `test/fixtures/offers.json` is a real OLX response with seller identities pseudonymised.

Local run:

```bash
npm run dev
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
```

## Limits this design works within

Cloudflare Workers Free allows 50 subrequests per invocation. A tick spends one per search plus one per
`(ad × chat)` send, and stops before it would start a broadcast it cannot finish — undelivered ads stay
unrecorded and go out on the next tick.

An ad is **claimed** in `seen_ads` before the first send and released again if no chat took it. The claim is
one SQL statement, so two overlapping ticks — or two searches matching the same ad — cannot both pass it,
which is what keeps the same listing from arriving twice within the same second. The cost is the opposite
failure mode: a crash between the claim and the last send loses that ad instead of duplicating it.
