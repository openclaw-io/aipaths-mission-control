-- Migration 029: Add first_28d YouTube Statistics launch window
-- Run in Supabase SQL Editor after 028.

ALTER TABLE ops_youtube_video_learning_snapshots
  DROP CONSTRAINT IF EXISTS ops_youtube_video_learning_snapshots_window_key_check;

ALTER TABLE ops_youtube_video_learning_snapshots
  ADD CONSTRAINT ops_youtube_video_learning_snapshots_window_key_check
  CHECK (window_key IN ('7d', '28d', 'lifetime', 'launch_day', 'first_7d', 'first_28d'));
