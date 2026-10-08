# Deploying your own Sites project

Local build and preview need no hosted account, credentials or network API calls.
A hosted deployment requires your own ChatGPT Sites project with the Worker,
ChatGPT sign-in, D1 and R2 capabilities available to you. This repository does not
grant platform access or public plugin distribution. Use the Sites controls
available to your account; no deployment CLI is assumed here.

## Project and bindings

Edit `worker/site-config.mjs` before building: set `siteOrigin` to your own Site's
exact HTTPS origin, without a trailing slash, and set `supportEmail` to your
service's contact address. The default `https://turnfeed.example` is a local
fixture. Photo and avatar rendering accepts only canonical URLs on the configured
origin; paths, credentials, query strings and fragments are not part of an origin.
The isolated preview uses the same configuration with loopback transport.

1. Create or select your own project. Copy `.openai/hosting.example.json` to
   `.openai/hosting.json`, which is ignored by Git.
2. Replace `project_id` with that project's real ID. Keep `d1: "DB"`,
   `r2: "BUCKET"` and `capabilities: ["mcp"]`. The packaging check accepts the
   `appgprj_` prefix followed by 32 lowercase hexadecimal characters; it validates
   the configuration's shape, not ownership or permission on the platform.
3. Bind a D1 database as `DB` and a private R2 bucket as `BUCKET`. Images must be
   served through the Worker's access checks; do not make the bucket public.
4. Configure the secrets below in Sites. Do not put them in hosting JSON, source
   files or the bundled Worker.

| Name | Purpose |
| --- | --- |
| `TURNFEED_SITE_SECRET` | Random secret of at least 32 characters; signs forms/references and derives account keys. Keep stable and back it up securely. Changing it changes account identity and invalidates signed references. |
| `OPENAI_API_KEY` | Server-side key used by the moderation adapter. Without working screening, new public text and photo writes fail closed. |
| `TURNFEED_OPERATOR_ACCOUNT_KEYS` | Optional comma-separated derived account keys authorized for operator review. Keep this private. |
| `TURNFEED_OPERATOR_SETUP` | Temporary owner-private bootstrap only; disabled for a shared deployment. |

`.env.example` is a reference. The build and preview do not load an environment
file. Confirm service availability and costs for your account before enabling
hosting or real API use; the local workflow makes no paid API calls.

## Migrations and packaging

Apply `drizzle/*.sql` in filename order to your own D1 database before serving
requests. The four existing migrations cover state storage, record storage,
photos and moderation attempt limits. Preserve the migration journal and
snapshots. `npm run db:generate` creates schema-only migration files; it does not
apply them to a hosted database. Local tests/preview apply all migrations to an
in-memory SQLite database automatically.

```sh
npm run build:deployment
```

This packages `dist/server/index.js` and the explicitly supplied configuration
at `dist/.openai/hosting.json`. Missing, placeholder or malformed configuration
stops packaging. It does not upload or publish anything. `npm run build` instead
creates a local bundle and removes any previously packaged hosting configuration,
even when a local deployment configuration exists.

Review the output project target before using your account's Sites deployment
workflow. The repository ships no production project identifier. Configure your
own branding, support contact and privacy information for an independent service.
Do not copy another deployment's secrets, user data or storage bindings.

## Operator bootstrap and verification

While the Site is owner-private, temporarily set `TURNFEED_OPERATOR_SETUP=1`.
A signed-in native own-profile read returns `structuredContent.turnfeedSitesAccountKey`.
Use that exact key in the private `TURNFEED_OPERATOR_ACCOUNT_KEYS` setting. Remove
the setup setting and redeploy before sharing. Do not guess a key from another
workspace or enable setup on a shared Site. Operator actions still use signed
previews and current database revisions.

Verify the deployed identity boundary, database writes, photo access and moderation
with controlled test accounts before accepting real users. Website access and
native plugin installation/host approval are separate checks. Keep tested backups
and a compatible rollback plan. Apply migration `0004_puzzling_colossus.sql` before
using the format-3 receipt adapter. Existing state migrates atomically on the next
successful write. After that write, rollback code must retain format-3 support and
private-account access checks. A format-2-only Worker cannot read the migrated data.
