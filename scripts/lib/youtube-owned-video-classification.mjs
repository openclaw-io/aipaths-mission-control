export function parseIsoDurationSeconds(value) {
  if (typeof value !== 'string' || !value) return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

export function classifyOwnedYoutubeVideo({ title, durationSeconds, privacyStatus }) {
  const parsedDuration = numberOrNull(durationSeconds);
  const normalizedPrivacy = typeof privacyStatus === 'string' && privacyStatus.trim()
    ? privacyStatus.trim().toLowerCase()
    : null;
  const videoKind = parsedDuration !== null && parsedDuration < 180 ? 'short' : 'longform';
  const isPublished = normalizedPrivacy ? normalizedPrivacy === 'public' : null;
  const excludedByTitle = /\b(clase|bootcamp|workshop|masterclass)\b/i.test(String(title || ''));
  const exclusionReasons = [
    ...(videoKind === 'short' ? ['duration_lt_180'] : []),
    ...(normalizedPrivacy && normalizedPrivacy !== 'public' ? ['non_public'] : []),
    ...(excludedByTitle ? ['class_title'] : []),
  ];

  return {
    video_kind: videoKind,
    is_published: isPublished,
    excluded_by_title: excludedByTitle,
    exclusion_reasons: exclusionReasons,
  };
}

export function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
