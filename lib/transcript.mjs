/** Whisper numeric offsets are milliseconds; clocks are seconds. */
export function parseClock(value) {
  const parts = String(value).trim().replace(",", ".").split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !Number.isFinite(p))) return NaN;
  return parts.reduce((sum, p) => sum * 60 + p, 0);
}

export function transcriptClock(value) {
  const ms = Math.round(Math.max(0, value) * 1000), seconds = Math.floor(ms / 1000);
  const whole = seconds >= 3600
    ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return whole + (ms % 1000 ? "." + String(ms % 1000).padStart(3, "0").replace(/0+$/, "") : "");
}

export function parseTranscript(text) {
  return [...String(text).matchAll(/^\[(\d[\d:.,]*)\s*[-–]\s*(\d[\d:.,]*)\]\s*(.+)$/gm)]
    .map((m) => ({ from: parseClock(m[1]), to: parseClock(m[2]), text: m[3].trim() }))
    .filter((s) => Number.isFinite(s.from) && s.to > s.from && s.text);
}

export function filterSuspectSegments(segments, { duration = Infinity } = {}) {
  const kept = [], discarded = { invalid: 0, punctuation: 0, sparse: 0 };
  for (const segment of segments) {
    const from = Number(segment.from), to = Math.min(Number(segment.to), duration);
    const text = String(segment.text || "").trim();
    const chars = [...text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) discarded.invalid++;
    else if (!chars) discarded.punctuation++;
    else if (to - from > 8 && chars / (to - from) < 0.8) discarded.sparse++;
    else kept.push({ from, to, text });
  }
  return { segments: kept, discarded, discardedCount: Object.values(discarded).reduce((a, b) => a + b, 0) };
}

export function alignSheets(sheets, segments) {
  return sheets.map((sheet) => ({ ...sheet, cells: (sheet.cells || []).map((cell) => ({
    ...cell,
    subtitles: segments.filter((s) => s.from < cell.to && s.to > cell.from),
  })) }));
}
