# Turnfeed on Sites

Turnfeed is a social feed for the web and native ChatGPT conversations. It includes
posts and threaded replies, profiles, photos, likes, following, private accounts,
notification activity, reports and operator moderation. Website and native tools
share the same handlers and data.

This repository tracks native Turnfeed updates through Site version 45,
including 3,000-character posts and compact feed previews from native commit `48755ce`.
Replies remain limited to 600 characters.
Hosting uses ChatGPT Sites identity, D1 storage and private R2 photo storage.
The included local preview works with synthetic users and disposable storage.
Public plugin distribution and host-specific behavior require separate verification.

## Local setup

Use **Node.js 25.5.0**, the development version checked for this snapshot, and its
bundled npm. Tests and preview use Node's built-in `node:sqlite`; an older runtime
without that module will not work. Other Node versions are not verified here.

From a fresh checkout:

```sh
npm ci
npm test
npm run build
npm run preview
```

Open the loopback URL printed by the preview command. It supplies a signed-in
sample user, sample posts, an in-memory database and mocked moderation. Changes
disappear when the process stops. Press Ctrl+C to stop. No Site credentials or
real API calls are needed. Dependencies are downloaded by `npm ci`; do not commit
`node_modules/`.

`npm run build` regenerates the retained core and bundles `dist/server/index.js`
for local use. It never includes a hosting configuration. To preview that bundle,
run `npm run preview:built` after building. The preview binds only to `127.0.0.1`;
it must not be exposed as a production server.

## Your own deployment

See [deployment setup](docs/deployment.md) for your own Sites project, the `DB` and
`BUCKET` bindings, SQL migrations, secrets and restricted operator bootstrap.
The repository contains a hosting **example**, with no production project ID.
Set your Site's exact HTTPS origin and support contact in `worker/site-config.mjs`
before building for a deployment; the default example origin is for local use.
`npm run build:deployment` requires your ignored `.openai/hosting.json` containing
a real project ID. Packaging does not publish or upload anything.

The Worker trusts authenticated Sites identity headers. Running it on a different
platform requires a trusted identity adapter; forwarding client-supplied identity
headers is unsafe. Local tests do not certify the hosted platform boundary.

## Development commands

| Command | Purpose |
| --- | --- |
| `npm run extract` | Regenerate retained core and tool schemas from vendored source and adapters. |
| `npm test` | Run tests with local SQLite and mocked external calls. |
| `npm run build` | Generate a local Worker bundle without a deployment target. |
| `npm run preview` | Start the disposable source preview on loopback. |
| `npm run preview:built` | Preview the existing bundled Worker on loopback. |
| `npm run db:generate` | Generate migration files from `db/schema.ts`; does not apply them. |
| `npm run build:deployment` | Package a bundle with an explicitly configured Sites target; does not deploy. |

See [CONTRIBUTING.md](CONTRIBUTING.md) for source-generation and migration rules.

## Architecture and limits

- `worker/`: request handling, web rendering, identity, moderation and storage adapters.
- `vendor/turnfeed/`: retained user-owned Turnfeed core at commit
  `1e1aa821f983f4e8234a16f68fe15915dc5aef26`; the original server is never started.
- `scripts/`: deterministic extraction, adapters, packaging and local preview.
- `db/` and `drizzle/`: schema and immutable SQL migrations.
- `test/`: synthetic fixtures and focused regression tests.

Selective feed, thread and settings reads reduce some database transfer. Writes
still hydrate full state, and feed ranking still loads the conversation trees it
needs. Shared state is bounded to 4 MiB and 8,192 rows. Post/reply retry receipts
are stored separately per account, so old receipts do not fill that shared budget.
This is not evidence of production-scale capacity; see [runtime notes](docs/runtime.md)
for migration, quotas, local measurements and rollback constraints.

Private accounts restrict post, reply and photo access to approved followers.
Names and handles remain discoverable. Automated moderation can reject legitimate
content and miss harmful content; reports and operator review remain necessary.
Native chat attachment transfer and public plugin installation need host-specific
verification. In-chat account closure is disabled; operator-assisted closure is
available. See [parity notes](docs/native-parity.md) and [SECURITY.md](SECURITY.md).

## License and branding

Turnfeed code and documentation use the [ISC license](LICENSE), including the
user-owned vendored core. The Turnfeed name and brand assets are reserved;
third-party dependencies retain their own licenses. See [NOTICE](NOTICE).
Replace branding and support/privacy contacts before operating an independent
service. Publication preparation is not an independent security audit.
