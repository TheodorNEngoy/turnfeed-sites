# Security and review status

This source snapshot has automated tests with synthetic users and local storage.
Those tests cover selected authorization, privacy, retry, moderation and storage
behaviors. They are not an independent audit or a guarantee that the software is
secure. Source review, local checks and hosted verification are separate evidence.
Review conclusions about original native v37 (`292155f`) apply to that revision.
Publication packaging and configuration changes are separately validated and are
not covered automatically by an earlier source review.

## Deployment boundaries

- The Worker trusts identity headers supplied by ChatGPT Sites. Do not expose it
  behind a server that accepts those headers from untrusted clients. Another
  hosting platform needs an authenticated identity adapter.
- The local preview supplies a synthetic identity and mocked moderation. Keep it
  on loopback; do not expose or deploy it as a service.
- Private content depends on current access checks and storage consistency.
  Preserve these when changing projections, caching, photos or account erasure.
- New content fails closed when moderation is unavailable. Tests and preview use
  mocked calls; never put live keys or real harmful media in fixtures.
- Capacity limits, disabled chat account closure and unverified native attachment
  transfer are documented in [runtime notes](docs/runtime.md). Public-scale
  operation and the hosted identity/storage boundaries need separate validation.

## Reporting a problem

Contact support@turnfeedapp.com privately with the affected commit, a concise
description and minimal reproduction using synthetic accounts. Do not include
credentials, user records or unnecessary personal information. Avoid public issue
details that expose private data or an exploitable production weakness.

This repository does not authorize testing live services or promise a bounty.
Keep reproduction in an isolated environment you control unless the operator has
explicitly authorized another scope.
