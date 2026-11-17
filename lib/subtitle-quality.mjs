/** Lexical non-overlap is a review signal, never independent proof of a wrong track. */
export function assessSubtitle(lines, { duration, lexical = {}, descriptionHits = 0, playerSource = "wbi" } = {}) {
  const issues = [];
  if (!Array.isArray(lines) || !lines.length) return { level: "missing", asrRecommended: true, issues: ["empty"] };
  let chars = 0, invalid = 0, overrun = 0;
  const tolerance = Math.max(5, Number(duration || 0) * 0.02);
  for (const l of lines) {
    chars += String(l.text || "").length;
    if (!Number.isFinite(l.from) || !Number.isFinite(l.to) || l.from < 0 || l.to <= l.from) invalid++;
    else if (duration > 0 && l.to > duration + tolerance) overrun++;
  }
  if (invalid) issues.push("invalid-timing");
  if (overrun) issues.push("beyond-selected-part");
  const charsPerSec = duration > 0 ? +(chars / duration).toFixed(2) : null;
  if (lexical.suspicious) issues.push("low-topic-overlap");
  if (charsPerSec != null && (charsPerSec < 1.5 || charsPerSec > 9)) issues.push("rate-outlier");
  if (playerSource === "legacy") issues.push("legacy-player");
  const suspect = invalid > 0 || overrun > 0;
  return { level: suspect ? "suspect" : issues.length ? "review" : "supported", asrRecommended: suspect,
    issues, charsPerSec, descriptionHits, playerSource };
}

export function stopOnAccountError(err) {
  if (["RiskControlError", "NotLoggedInError"].includes(err?.name) || /风控暂停中|超过上限.*请求|今天已经发了/.test(err?.message || "")) throw err;
}
