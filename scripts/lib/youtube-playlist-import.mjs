const PLAYLIST_KINDS = new Set(["hub", "official_series", "archive", "shorts"]);
const PLAYLIST_STATUSES = new Set(["active", "archived", "draft"]);
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message) {
  throw new Error(`youtube_playlist_snapshot_invalid: ${message}`);
}
function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}
function nullableString(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(`${field} must be a string or null`);
  return value;
}
function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} is required`);
  return value.trim();
}
function strings(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) fail(`${field} must be a string array`);
  return value.map((entry) => entry.trim()).filter((entry, index, all) => all.indexOf(entry) === index);
}

export function parseCatalogJson(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { fail("catalog is not valid JSON"); }
  object(raw, "catalog");
  if (raw.schema_version !== 1) fail("schema_version must be 1");
  const source = requiredString(raw.source, "source");
  const sourceObservedAt = requiredString(raw.source_observed_at, "source_observed_at");
  if (Number.isNaN(Date.parse(sourceObservedAt))) fail("source_observed_at must be an ISO timestamp");
  if (!Array.isArray(raw.playlists)) fail("playlists must be an array");

  const ids = new Set();
  const slugs = new Set();
  const playlists = raw.playlists.map((entry, index) => {
    object(entry, `playlists[${index}]`);
    const playlistId = requiredString(entry.playlist_id, `playlists[${index}].playlist_id`);
    const slug = requiredString(entry.canonical_slug, `playlists[${index}].canonical_slug`);
    if (!SAFE_ID.test(playlistId)) fail(`playlists[${index}].playlist_id is invalid`);
    if (!SAFE_SLUG.test(slug)) fail(`playlists[${index}].canonical_slug is invalid`);
    if (ids.has(playlistId)) fail(`duplicate playlist_id ${playlistId}`);
    if (slugs.has(slug)) fail(`duplicate canonical_slug ${slug}`);
    ids.add(playlistId); slugs.add(slug);
    if (!PLAYLIST_KINDS.has(entry.kind)) fail(`playlists[${index}].kind is invalid`);
    if (!PLAYLIST_STATUSES.has(entry.status)) fail(`playlists[${index}].status is invalid`);
    if (typeof entry.featured !== "boolean") fail(`playlists[${index}].featured must be boolean`);
    const homeOrder = entry.home_order === null || entry.home_order === undefined ? null : entry.home_order;
    if (homeOrder !== null && (!Number.isInteger(homeOrder) || homeOrder < 1)) fail(`playlists[${index}].home_order is invalid`);
    if (entry.featured && homeOrder === null) fail(`playlists[${index}] featured playlists need home_order`);
    const url = requiredString(entry.url, `playlists[${index}].url`);
    if (url !== `https://www.youtube.com/playlist?list=${playlistId}`) fail(`playlists[${index}].url must match playlist_id`);
    return {
      playlist_id: playlistId,
      canonical_slug: slug,
      title: requiredString(entry.title, `playlists[${index}].title`),
      description: nullableString(entry.description, `playlists[${index}].description`),
      url,
      kind: entry.kind,
      purpose: nullableString(entry.purpose, `playlists[${index}].purpose`),
      audience: nullableString(entry.audience, `playlists[${index}].audience`),
      status: entry.status,
      featured: entry.featured,
      home_order: homeOrder,
      aliases: strings(entry.aliases, `playlists[${index}].aliases`),
      use_cases: strings(entry.use_cases, `playlists[${index}].use_cases`).map((value) => value.toLowerCase()),
      tags: strings(entry.tags, `playlists[${index}].tags`).map((value) => value.toLowerCase()),
      source_metadata: object(entry.source_metadata ?? {}, `playlists[${index}].source_metadata`),
      live_metadata: object(entry.live_metadata ?? {}, `playlists[${index}].live_metadata`),
    };
  });
  return { schema_version: 1, source, source_observed_at: sourceObservedAt, playlists };
}

export function parseMembershipTsv(text) {
  const rows = [];
  const seenMemberships = new Set();
  const seenPositions = new Set();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    const columns = rawLine.includes("\t") ? rawLine.split("\t") : rawLine.split("\\t");
    if (columns.length !== 6) fail(`memberships line ${index + 1} must have 6 columns`);
    const [playlistIdRaw, sourcePlaylistTitleRaw, positionRaw, videoIdRaw, titleRaw, durationRaw] = columns;
    const playlistId = requiredString(playlistIdRaw, `memberships line ${index + 1} playlist_id`);
    const videoId = requiredString(videoIdRaw, `memberships line ${index + 1} video_id`);
    if (!SAFE_ID.test(playlistId) || !SAFE_ID.test(videoId)) fail(`memberships line ${index + 1} has an invalid ID`);
    const position = Number(positionRaw);
    if (!Number.isInteger(position) || position < 1) fail(`memberships line ${index + 1} position is invalid`);
    const membershipKey = `${playlistId}\u0000${videoId}`;
    if (seenMemberships.has(membershipKey)) fail(`memberships line ${index + 1} duplicates ${playlistId}/${videoId}`);
    seenMemberships.add(membershipKey);
    const positionKey = `${playlistId}\u0000${position}`;
    if (seenPositions.has(positionKey)) fail(`memberships line ${index + 1} duplicates ${playlistId} position ${position}`);
    seenPositions.add(positionKey);
    if (!durationRaw.trim()) fail(`memberships line ${index + 1} duration is invalid`);
    const duration = durationRaw === "NA" ? null : Number(durationRaw);
    if (duration !== null && (!Number.isFinite(duration) || duration < 0)) fail(`memberships line ${index + 1} duration is invalid`);
    rows.push({
      playlist_id: playlistId,
      source_playlist_title: requiredString(sourcePlaylistTitleRaw, `memberships line ${index + 1} playlist title`),
      position,
      video_id: videoId,
      title: titleRaw === "NA" ? null : requiredString(titleRaw, `memberships line ${index + 1} video title`),
      membership_reason: "observed_in_source_snapshot",
      membership_role: "existing_membership",
      source_metadata: duration === null ? {} : { duration_seconds: duration },
    });
  }
  return rows;
}

export async function upsertPlaylistSnapshot(pool, snapshot) {
  object(snapshot, "snapshot");
  if (!Array.isArray(snapshot.playlists) || !Array.isArray(snapshot.memberships)) fail("playlists and memberships are required");
  const playlistIds = new Set(snapshot.playlists.map((playlist) => playlist.playlist_id));
  for (const membership of snapshot.memberships) {
    if (!playlistIds.has(membership.playlist_id)) fail(`membership references absent playlist ${membership.playlist_id}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mission-control:youtube-playlist-import', 0))");
    for (const playlist of snapshot.playlists) {
      await client.query(`
        INSERT INTO public.youtube_playlists (
          playlist_id, canonical_slug, title, description, url, kind, purpose, audience, status,
          featured, home_order, aliases, use_cases, tags, source, source_metadata, live_metadata,
          source_observed_at, last_synced_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text[],$13::text[],$14::text[],$15,$16::jsonb,$17::jsonb,$18,now())
        ON CONFLICT (playlist_id) DO UPDATE SET
          canonical_slug=EXCLUDED.canonical_slug, title=EXCLUDED.title, description=EXCLUDED.description,
          url=EXCLUDED.url, kind=EXCLUDED.kind, purpose=EXCLUDED.purpose, audience=EXCLUDED.audience,
          status=EXCLUDED.status, featured=EXCLUDED.featured, home_order=EXCLUDED.home_order,
          aliases=EXCLUDED.aliases, use_cases=EXCLUDED.use_cases, tags=EXCLUDED.tags, source=EXCLUDED.source,
          source_metadata=EXCLUDED.source_metadata, live_metadata=EXCLUDED.live_metadata,
          source_observed_at=EXCLUDED.source_observed_at, last_synced_at=now(), updated_at=now()
      `, [
        playlist.playlist_id, playlist.canonical_slug, playlist.title, playlist.description, playlist.url,
        playlist.kind, playlist.purpose, playlist.audience, playlist.status, playlist.featured,
        playlist.home_order, playlist.aliases, playlist.use_cases, playlist.tags, snapshot.source,
        JSON.stringify(playlist.source_metadata), JSON.stringify(playlist.live_metadata), snapshot.source_observed_at,
      ]);
    }
    await client.query(
      "DELETE FROM public.youtube_playlist_videos WHERE playlist_id = ANY($1::text[])",
      [Array.from(playlistIds)],
    );
    for (const membership of snapshot.memberships) {
      await client.query(`
        INSERT INTO public.youtube_playlist_videos (
          playlist_id, video_id, title, position, membership_reason, membership_role, source_metadata
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (playlist_id, video_id) DO UPDATE SET
          title=EXCLUDED.title, position=EXCLUDED.position, membership_reason=EXCLUDED.membership_reason,
          membership_role=EXCLUDED.membership_role, source_metadata=EXCLUDED.source_metadata, updated_at=now()
      `, [membership.playlist_id, membership.video_id, membership.title, membership.position,
        membership.membership_reason, membership.membership_role, JSON.stringify(membership.source_metadata)]);
    }
    await client.query("COMMIT");
    return { playlists: snapshot.playlists.length, memberships: snapshot.memberships.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
