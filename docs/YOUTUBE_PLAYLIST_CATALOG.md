# Canonical YouTube playlist catalog

Mission Control owns a **read-mostly canonical catalog** of AIPaths playlists. It records evidenced editorial intent and observed playlist membership; it is not a YouTube authoring tool and no catalog code writes to YouTube.

## Ownership and boundaries

- **Editorial owner:** AIPaths YouTube/content lead. Approves title, purpose, audience, home placement, aliases, use cases, and tags.
- **Operational owner:** Mission Control / Systems. Maintains the migration, validates snapshots, runs imports, and monitors API/UI availability.
- **Source of live truth:** YouTube. `playlist_id`, observed titles, and memberships must come from an audit or a read-only API snapshot.
- **Source of editorial truth:** the approved architecture document referenced in `source_metadata`.
- Unknown values remain `null`, empty, or absent. Planned playlists without a real YouTube playlist ID are not materialized. Resolvers never use fuzzy matching.
- OAuth credentials, access tokens, refresh tokens, and API secrets must never be placed in catalog JSON, TSV, database metadata, logs, or commits.

The 2026-07-31 seed artifacts are:

- `data/youtube-playlists/2026-07-31-catalog.json`: six long-form playlists whose IDs were present in the public audit. Shorts playlists are intentionally excluded from the canonical agent catalog and from all agent-selection workflows. The catalog's canonical title, description, purpose, taxonomy, and placement are **approved intended editorial metadata**, not a claim about the current YouTube UI. Each playlist marks this payload as `source_metadata.metadata_kind=approved_editorial_intent`.
- `data/youtube-playlists/2026-07-31-memberships.tsv`: the 54 observed long-form playlist memberships. Shorts memberships are excluded. `live_metadata` is separately marked `metadata_kind=observed_live_state`; it must not be interpreted as approved intended metadata.
- `data/youtube-playlists/sources/architecture-v2.md`: byte-for-byte approved editorial source, SHA-256 `5bc2c3c0b4d1d856cb0b7a00dc0ed58a3dbd2b4d2ddf0fcbf1583048046db622`.
- `data/youtube-playlists/sources/audit.md`: byte-for-byte live-observation audit, SHA-256 `9368660747bf64665bb99c6251f7add9806bb9406aaa9ea159799ca2218ff894`.

Every seeded playlist's `source_metadata` records both stable repository-relative source paths and their SHA-256 hashes. This makes the editorial approval and observed-live evidence independently auditable even if the external outgoing directory changes.

Playlists proposed by the architecture but lacking an observed playlist ID (for example Tutoriales Técnicos, Casos Reales, and the proposed official series) are intentionally omitted rather than assigned synthetic IDs.

## Schema

Migration `supabase/migrations/036_create_youtube_playlist_catalog.sql` creates:

- `youtube_playlists`: YouTube ID, canonical slug, title/description/URL, constrained kind/status, purpose/audience, home placement, aliases/use cases/tags, source/live metadata, and timestamps.
- `youtube_playlist_videos`: playlist/video identity, evidenced title and position, membership reason/role, metadata, and timestamps.

The same additive tables, indexes, and RLS posture are present in `ops/local-postgres/schema.sql` for local bootstrap and disposable tests. Cloud RLS permits authenticated reads and service-role writes. The local `aipaths_mc_app` API role has SELECT-only RLS policies on both catalog tables: it can serve the API/UI but cannot import or otherwise mutate catalog rows, even though the bootstrap's later broad table grants are preserved. Normal migration review/application remains the deployment path; this feature does not deploy or mutate a live database by itself.

## Validate and import

Validation is dry-run by default and does not require a database:

```bash
npm run import:youtube-playlists -- \
  --catalog data/youtube-playlists/2026-07-31-catalog.json \
  --memberships data/youtube-playlists/2026-07-31-memberships.tsv \
  --dry-run
```

After migration review, import into an explicitly selected local database:

```bash
MISSION_CONTROL_DATABASE_URL="postgresql://${USER}@127.0.0.1:5432/aipaths_mission_control_local" \
  npm run import:youtube-playlists -- \
  --catalog data/youtube-playlists/2026-07-31-catalog.json \
  --memberships data/youtube-playlists/2026-07-31-memberships.tsv \
  --apply
```

The apply connection must be an approved operator/table-owner connection (as in the local example above) or an approved Supabase `service_role` database connection. Never run imports as `aipaths_mc_app`; that API application role is intentionally read-only and RLS will reject INSERT, UPDATE, and DELETE.

Remote targets fail closed unless the operator also passes `--allow-remote`. That flag is an explicit safety acknowledgement, not permission to bypass migration/change-control review. The importer validates the full input before connecting, uses a transaction and advisory lock, and upserts playlists on stable YouTube IDs. Memberships use transactional snapshot replacement: for each playlist included in the input, existing memberships are deleted and the validated snapshot is inserted within the same transaction. This staging allows positions to be reordered without colliding with the unique `(playlist_id, position)` constraint and makes replay converge by removing stale rows. Playlists omitted from the input are outside the replacement scope and retain all memberships.

An existing YouTube OAuth integration is used elsewhere for read-only analytics/metadata, but this catalog intentionally ingests a credential-free snapshot contract. A future read-only YouTube Data API adapter should emit this same JSON/TSV contract and must not add playlist mutation scopes or calls.

## Agent API

Authenticated endpoint:

```text
GET /api/agent/youtube/playlists
Authorization: Bearer <agent-key>
```

Filters:

- `status=active|archived|draft|all` (default `active`)
- repeated or comma-separated `use_case`
- repeated or comma-separated `tag`
- `include_videos=true|false`
- `resolve=<reference>` for exact playlist ID, canonical slug, or alias resolution

Example:

```bash
curl -fsS \
  -H "Authorization: Bearer <agent-key>" \
  'http://127.0.0.1:3001/api/agent/youtube/playlists?use_case=agent-implementation&status=active&include_videos=true'
```

Resolver outcomes are deterministic: exact unique match returns `200`, no exact match returns `404`, and an alias collision returns `409` with candidate IDs. Partial and fuzzy terms are never resolved.

## UI and verification

The authenticated local UI is read-only at `/youtube/playlists` and shows active playlists, editorial purpose/use cases, canonical URLs, and ordered memberships.

```bash
npm run test:youtube-playlists
npm run build
```

Tests run against the repository's disposable Postgres architecture and cover schema constraints, filters/resolution, API authentication and response shape, TSV/JSON parsing, transactional idempotent upsert, and the read-only render/navigation surface.
