# Native Turnfeed: retained work and remaining gaps

Historical source comparison recorded 2026-10-01 against `TheodorNEngoy/chatgpt-social-mvp`.

Product direction: build native Turnfeed as an independent in-chat product. Retain useful existing behavior and choose further work by its benefit to native users. Legacy Auth0 accounts and historical data are outside the migration scope.

## Source continuity

The retained source commit is `1e1aa821f983f4e8234a16f68fe15915dc5aef26`. GitHub main was `38d7bd6f8965d0415306b723c1343ff1cc7ae64c`; the retained commit contains main plus three Events-candidate commits, with no main commits missing at that comparison. All 16 vendored files then matched their source Git blob hashes. This records source continuity at extraction; it does not prove every old website route is available through the native plugin.

The deterministic extraction keeps all 24 original chat tools and their reachable logic. Retained behavior includes feed ranking and search, time filters and pagination, full conversation reads, profiles, inbox activity, posts and nested replies, quotes, edits, deletion previews, likes, pins, following, blocking and reports. Original content filtering, ownership checks, validation, write receipts and retry protection remain in the extracted core.

## Private settings now available in chat

Three native tools expose the existing settings and mute handlers:

- `get_my_settings`: private notification preferences, hidden words and paginated muted people.
- `update_my_settings`: patch selected notification flags and add/remove/clear hidden words.
- `mute_user`: mute or unmute the person identified by a readable name and matching handle or viewer-bound target reference.

Account identity comes only from authenticated Sites context. These tools retain the original filtering, limits and relationship behavior. The native mute adapter adds readable-target verification. Settings writes omit the old five-second payload-only duplicate suppression, which could incorrectly skip a rapid change back to an earlier value. Desired-state updates, durable storage concurrency control and rate limits remain in place.

The new controls affect the Turnfeed feed and inbox; they do not enable push notifications or MCP Events. As of 2026-10-06, the website provides feeds, paginated conversations, posts, replies, profile edits and confirmed own-post deletion through the same native handlers and D1 data. It adds no web chat model or push notifications. Website access and cross-account plugin installation remain separate capabilities.

## Explicit differences and remaining work

- Sites provides ChatGPT sign-in, hosting and D1 persistence. Existing-service accounts and data are separate.
- The optional ChatGPT account name can initialize a profile; it is not synchronization with the separate public ChatGPT profile name. User-chosen names are preserved.
- The public website provides Add photo on the post composer, without a plugin. One selected JPEG/PNG chat attachment is also accepted through `create_post.photo`, with private R2 storage, metadata stripping, visibility checks and fixed quotas documented in [runtime notes](runtime.md). Native host file transfer remains unverified. Video-file uploads, arbitrary external attachments, remote link previews and Events delivery remain disabled. Ordinary text and YouTube/Vimeo links work.
- Native `export_my_data` provides a private account export with explicit coverage limits and signed continuation. In-chat account closure is disabled: model-visible preview tokens and phrases cannot prove later human confirmation. Both closure tool names are removed from discovery and cached calls are rejected before storage access. Closure requests go to support; the separate operator erasure workflow remains. `reset_me` retains its original semantics and is not a substitute for account closure. Installed-host account behavior requires separate verification.
- Groups were already disabled in the retained service. This port does not re-enable them.
- The native experience uses conversational tool output rather than the old interactive card. Aggregate activation/timing instrumentation is disabled.
- Record storage reduces small-write cost. Feed, settings and ordinary non-quoted conversation reads load selected payloads with revision and integrity checks. Feed ranking still needs all relevant conversation trees and relationships; writes and fallback paths hydrate the bounded full state. The [runtime notes](runtime.md) document measured transfer reductions, the remaining full digest-index cost, the 4 MiB/8,192-row limits and migration constraints.
- Public installation/sharing, host approval behavior and public-scale operation need independent verification. Local passing tests and a private deployment do not establish those capabilities.

## Public text and photo screening (2026-10-08)

The public website is the primary route. The shared native/website dispatcher now checks actual new or changed public content with the free OpenAI Moderation API before committing it. The original heuristic checks, rate limits, reports, operator actions and storage limits remain. JPEG/PNG photo selection is available in the website post composer and requires the same screening. A moderation failure stops publication. My profile supports explicitly selected JPEG/PNG profile pictures with the same screening and shared quotas. Replacement, removal and reset revoke the old picture’s ordinary access. Operator removal preserves restricted evidence. No ChatGPT avatar is imported automatically. Automated screening has false positives and misses; this is not a claim that all harmful content is detected.

## Website social basics (2026-10-08)

Follow/unfollow, post/reply likes, public author-profile navigation and a Following list are exposed on the website using the retained native handlers. Accounts can be public or private. Private-account posts, replies, bio and photos require approved-follower access; names and handles remain discoverable. Private preferences and blocking remain separate controls. Browser photo preparation supports larger selected originals while keeping storage and screening limits unchanged.
