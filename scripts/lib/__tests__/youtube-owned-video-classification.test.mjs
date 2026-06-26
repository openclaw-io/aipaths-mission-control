import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyOwnedYoutubeVideo,
  parseIsoDurationSeconds,
} from '../youtube-owned-video-classification.mjs';

test('parseIsoDurationSeconds parses YouTube ISO durations', () => {
  assert.equal(parseIsoDurationSeconds('PT1M28S'), 88);
  assert.equal(parseIsoDurationSeconds('PT2H17M'), 8220);
  assert.equal(parseIsoDurationSeconds('PT29M18S'), 1758);
  assert.equal(parseIsoDurationSeconds(null), null);
  assert.equal(parseIsoDurationSeconds(''), null);
});

test('classifyOwnedYoutubeVideo marks sub-180-second public videos as shorts', () => {
  assert.deepEqual(classifyOwnedYoutubeVideo({
    title: 'Los 4 pilares del contexto ⚡',
    durationSeconds: 88,
    privacyStatus: 'public',
  }), {
    video_kind: 'short',
    is_published: true,
    excluded_by_title: false,
    exclusion_reasons: ['duration_lt_180'],
  });
});

test('classifyOwnedYoutubeVideo marks unlisted bootcamp classes non-public and title-excluded', () => {
  assert.deepEqual(classifyOwnedYoutubeVideo({
    title: 'Clase #1 Bootcamp Marzo 2026',
    durationSeconds: 8220,
    privacyStatus: 'unlisted',
  }), {
    video_kind: 'longform',
    is_published: false,
    excluded_by_title: true,
    exclusion_reasons: ['non_public', 'class_title'],
  });
});

test('classifyOwnedYoutubeVideo does not force publication state when privacy is unknown', () => {
  assert.deepEqual(classifyOwnedYoutubeVideo({
    title: 'Demo video',
    durationSeconds: 421,
    privacyStatus: null,
  }), {
    video_kind: 'longform',
    is_published: null,
    excluded_by_title: false,
    exclusion_reasons: [],
  });
});
