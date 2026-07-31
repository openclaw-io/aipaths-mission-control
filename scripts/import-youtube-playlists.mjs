#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import pg from "pg";
import { parseCatalogJson, parseMembershipTsv, upsertPlaylistSnapshot } from "./lib/youtube-playlist-import.mjs";

function usage() {
  console.log(`Usage:
  npm run import:youtube-playlists -- --catalog <catalog.json> --memberships <memberships.tsv> [--dry-run]
  npm run import:youtube-playlists -- --catalog <catalog.json> --memberships <memberships.tsv> --apply [--allow-remote]

Dry-run is the default. --apply requires MISSION_CONTROL_DATABASE_URL. Remote database URLs are
rejected unless --allow-remote is also present. This importer only changes Mission Control; it never
calls or writes to YouTube.`);
}

function parseArgs(args) {
  const options = { catalog: null, memberships: null, apply: false, allowRemote: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--catalog") options.catalog = args[++index];
    else if (arg.startsWith("--catalog=")) options.catalog = arg.slice(10);
    else if (arg === "--memberships") options.memberships = args[++index];
    else if (arg.startsWith("--memberships=")) options.memberships = arg.slice(14);
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--allow-remote") options.allowRemote = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function assertDatabaseTarget(connectionString, allowRemote) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error("MISSION_CONTROL_DATABASE_URL must be a valid PostgreSQL URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("MISSION_CONTROL_DATABASE_URL must use postgres:// or postgresql://");
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (!loopback && !allowRemote) throw new Error("remote database rejected; inspect the dry-run and pass --allow-remote explicitly");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
  } else {
    if (!options.catalog || !options.memberships) throw new Error("--catalog and --memberships are required");
    const [catalogText, membershipsText] = await Promise.all([
      readFile(options.catalog, "utf8"),
      readFile(options.memberships, "utf8"),
    ]);
    const snapshot = { ...parseCatalogJson(catalogText), memberships: parseMembershipTsv(membershipsText) };
    const unknown = snapshot.memberships.filter((membership) => !snapshot.playlists.some((playlist) => playlist.playlist_id === membership.playlist_id));
    if (unknown.length) throw new Error(`membership snapshot references ${unknown.length} absent playlist(s)`);

    if (!options.apply) {
      console.log(JSON.stringify({ mode: "dry-run", source: snapshot.source, playlists: snapshot.playlists.length, memberships: snapshot.memberships.length }, null, 2));
    } else {
      const connectionString = process.env.MISSION_CONTROL_DATABASE_URL;
      if (!connectionString) throw new Error("MISSION_CONTROL_DATABASE_URL is required with --apply");
      assertDatabaseTarget(connectionString, options.allowRemote);
      const pool = new pg.Pool({ connectionString, max: 1 });
      try {
        const result = await upsertPlaylistSnapshot(pool, snapshot);
        console.log(JSON.stringify({ mode: "applied", source: snapshot.source, ...result }, null, 2));
      } finally {
        await pool.end();
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
