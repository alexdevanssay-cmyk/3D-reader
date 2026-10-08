// Backtest of the estimate of the casting cycle time by the AI (ai-cycle.js)
// on the history of cycle times (history.js), button "Banc d'essai IA" of the
// card "Historique des temps de cycle": for each record with its geometry
// (weight and modulus), the formula of routes.js with the current settings
// and the estimate of the AI made without the record (leave one out: neither
// it nor another record of its reference among the similar parts sent),
// against the time of the record. A time of source "devis" was estimated by
// the estimators, it is not a measure. The requests go one after another,
// paced for the free plan of Groq (30 requests and 8,000 tokens a minute); a
// refusal for quota stops the run, which resumes where it stopped. Nothing of
// it is applied to a quote or to the settings. Pure functions and the
// scheduler, no DOM: ui.js asks the AI and keeps the results.

import { formulaCycle } from "./history.js";

// Time between the starts of two requests to the gateway before its quota is known (s).
export const DEFAULT_INTERVAL_S = 20;
// The fastest pace: the gateway takes 20 requests a minute from an address (api/ai.js) and an
// estimate asks it twice (its configuration, then the question); Groq takes 30 a minute.
export const MIN_INTERVAL_S = 6;
// Room kept in the tokens of a minute: a request may take more than the largest one seen.
const MARGIN = 1.15;
// HTTP statuses of a refusal for quota (api/ai.js): the run stops there.
const QUOTA_STATUSES = [413, 429];

const isPositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** The key of a record in the results: its source and reference (without a reference: its values). */
export const backtestKey = (r) => `${r.source}|${r.ref ?? JSON.stringify(r)}`;

/** What a result was made from: when one of these values of its record changes, the record is estimated again. */
export const fingerprint = (r) => JSON.stringify([r.ilot, r.temps_cycle_s, r.poids_kg, r.module_mm, r.pieces_par_cycle ?? null, r.mise_au_mille ?? null, r.noyaux ?? null]);

/** The records the backtest runs on, those with a weight and a modulus: [{key, record}], in the order of the history. */
export function backtestItems(history) {
  return history.filter((r) => isPositive(r.poids_kg) && isPositive(r.module_mm)).map((record) => ({ key: backtestKey(record), record }));
}

/** The history the AI may be given for `record`: without it, nor another record of its reference (the same part, of the other source). */
export function leaveOneOut(history, record) {
  const own = JSON.stringify(record);
  return history.filter((x) => (record.ref ? x.ref !== record.ref : JSON.stringify(x) !== own));
}

/** The result kept for the record of `item` in `results`, if it was made from its current values; else null. */
export const resultOf = (results, item) => (results?.[item.key]?.empreinte === fingerprint(item.record) ? results[item.key] : null);

/** A duration of the rate-limit headers ("7.66s", "2m59.56s", "1h2m") or a number of seconds, in seconds; null if none. */
export function duration(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  const parts = [...String(value).matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length) return null;
  return parts.reduce((s, [, n, unit]) => s + Number(n) * { h: 3600, m: 60, s: 1, ms: 0.001 }[unit], 0);
}

/**
 * The pace after an answer of the gateway (`answer`: {quota, usage}, as
 * api/ai.js gives them), from the pace until then (`before`): `tokens`, the
 * largest request seen (its usage, else what the minute lost with the first
 * one); `interval` (ms), between the starts of two requests, such that a
 * minute holds as many of them as its tokens allow (tokens_limit_minute),
 * never under MIN_INTERVAL_S, DEFAULT_INTERVAL_S while unknown; `wait` (ms,
 * from the answer), until the tokens of the minute are back (reset_tokens)
 * when fewer are left than a request takes.
 */
export function nextPace(answer, before = { interval: DEFAULT_INTERVAL_S * 1000, tokens: null }) {
  const q = answer?.quota ?? {};
  const limit = isPositive(q.tokens_limit_minute) ? q.tokens_limit_minute : null;
  const left = Number.isFinite(q.tokens_remaining_minute) ? q.tokens_remaining_minute : null;
  const used = isPositive(answer?.usage?.total_tokens) ? answer.usage.total_tokens : limit && left !== null && !before.tokens ? limit - left : null;
  const tokens = Math.max(before.tokens ?? 0, used ?? 0) || null;
  const interval = tokens && limit ? Math.max(MIN_INTERVAL_S * 1000, Math.ceil((60_000 * tokens * MARGIN) / limit)) : before.interval;
  const reset = duration(q.reset_tokens);
  const wait = tokens && left !== null && left < tokens * MARGIN && reset !== null ? Math.ceil(reset * 1000) : 0;
  return { interval, tokens, wait };
}

const abortError = () => new DOMException("Banc d'essai annulé.", "AbortError");

/** Resolves after `ms`, or rejects with an AbortError when `signal` aborts. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * The backtest run on `items` (backtestItems), one record after another:
 * those without a result in `results` (resultOf), so a run resumes where the
 * last one stopped. `estimate(item, signal)` resolves to {result, quota,
 * usage}: the result kept for the record (with its `empreinte`), the quota
 * and usage of the gateway's answer. Paced by nextPace, unless the AI is
 * local (`local`); `notBefore` (ms, as `now`): the earliest start of the first
 * request, the `next` of the run before. Stops on a refusal for quota (status
 * 413 or 429; its retryAfter, s, pushes `next` back), when the gateway tells
 * the requests of the day are used up, on any other error (the record is
 * asked again at the next run) and when `signal` aborts.
 *   onResult(item, result); onProgress({done, total, item, waitUntil (ms) | null})
 * Resolves to {status: "done" | "quota" | "error" | "cancelled", message,
 * retryAfter (s) | null, done, total, next (ms: the earliest start of the next request)}.
 */
export async function runBacktest(items, { results = {}, estimate, onResult = () => {}, onProgress = () => {}, signal, local = false, notBefore = 0, now = Date.now, sleep = pause } = {}) {
  const total = items.length;
  const todo = items.filter((item) => !resultOf(results, item));
  let done = total - todo.length;
  let pace = { interval: local ? 0 : DEFAULT_INTERVAL_S * 1000, tokens: null };
  let next = local ? 0 : notBefore;
  const end = (status, extra = {}) => ({ status, message: null, retryAfter: null, done, total, next, ...extra });
  const later = (seconds) => (seconds !== null ? Math.max(next, now() + seconds * 1000) : next);
  for (const [i, item] of todo.entries()) {
    let answer;
    try {
      if (next > now()) {
        onProgress({ done, total, item, waitUntil: next });
        await sleep(next - now(), signal);
      }
      if (signal?.aborted) return end("cancelled");
      onProgress({ done, total, item, waitUntil: null });
      const start = now();
      answer = await estimate(item, signal);
      if (!local) {
        pace = nextPace(answer, pace);
        next = Math.max(start + pace.interval, now() + pace.wait);
      }
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) return end("cancelled");
      if (QUOTA_STATUSES.includes(err?.status)) {
        const retryAfter = duration(err.retryAfter ?? null);
        return end("quota", { message: err.message, retryAfter, next: later(retryAfter) });
      }
      return end("error", { message: err?.message || String(err) });
    }
    done++;
    onResult(item, answer.result);
    // The requests of the day used up: the next ones would be refused.
    if (answer.quota?.requests_remaining_day === 0 && i < todo.length - 1) {
      const retryAfter = duration(answer.quota.reset_requests);
      return end("quota", { message: "Plus aucune requête permise aujourd'hui par le quota en ligne.", retryAfter, next: later(retryAfter) });
    }
  }
  return end("done");
}

// --------------------------------------------------------------------------- the results

/**
 * The rows of the results table: each record of `items` with its time (the
 * reference), the cycle the formula of routes.js gives it with the settings
 * `settings` (history.js formulaCycle) and the estimate of the AI kept in
 * `results`, each with its relative error (estimate − reference) / reference.
 *   [{key, record, reference, formule: {valeur, ecart} | null,
 *     ia: {valeur, min, max, ecart, dedans (the reference within the range)} | null,
 *     resultat (kept: with its error when the answer could not be used) | null}]
 */
export function backtestRows(items, results, settings) {
  return items.map((item) => {
    const { record } = item;
    const reference = record.temps_cycle_s;
    const formule = formulaCycle(record, settings);
    const r = resultOf(results, item);
    const [min, max] = r?.fourchette_s ?? [];
    return {
      key: item.key,
      record,
      reference,
      formule: isPositive(formule) ? { valeur: formule, ecart: (formule - reference) / reference } : null,
      ia: isPositive(r?.estimation_s) ? { valeur: r.estimation_s, min, max, ecart: (r.estimation_s - reference) / reference, dedans: reference >= min && reference <= max } : null,
      resultat: r,
    };
  });
}

/** Mean absolute relative error of the estimates `items` ({ecart}) that are there: {n, emap}, or null. */
function meanError(items) {
  const gaps = items.filter((x) => x).map((x) => Math.abs(x.ecart));
  return gaps.length ? { n: gaps.length, emap: gaps.reduce((a, b) => a + b, 0) / gaps.length } : null;
}

/**
 * The summary of the rows the AI estimated (the formula over the same
 * records): overall (`total`), by island (`ilots`) and by source (`sources`),
 * each {ilot | source, n, devis, production, formule: {n, emap} | null, ia:
 * {n, emap} | null, dedans (records whose reference is within the range of
 * the AI)}; and the records whose answer could not be used (`erreurs`) or not
 * yet estimated (`restantes`).
 */
export function summarizeBacktest(rows) {
  const scored = rows.filter((x) => x.ia);
  const summary = (key, rs) => ({
    ...key,
    n: rs.length,
    devis: rs.filter((x) => x.record.source === "devis").length,
    production: rs.filter((x) => x.record.source === "production").length,
    formule: meanError(rs.map((x) => x.formule)),
    ia: meanError(rs.map((x) => x.ia)),
    dedans: rs.filter((x) => x.ia.dedans).length,
  });
  const islands = [...new Set(scored.map((x) => x.record.ilot))].sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
  const sources = ["devis", "production"].filter((s) => scored.some((x) => x.record.source === s));
  return {
    total: summary({}, scored),
    ilots: islands.map((ilot) => summary({ ilot }, scored.filter((x) => x.record.ilot === ilot))),
    sources: sources.map((source) => summary({ source }, scored.filter((x) => x.record.source === source))),
    erreurs: rows.filter((x) => !x.ia && x.resultat?.erreur).length,
    restantes: rows.filter((x) => !x.resultat).length,
  };
}

const fr = (v, digits = 1) => v.toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (v, digits = 1) => `${fr(v * 100, digits)} %`;
const plural = (n, word, words = `${word}s`) => `${n} ${n > 1 ? words : word}`;

/**
 * The summary (summarizeBacktest) in plain French, under the table; "" before
 * any estimate. `tendance`: cycle coefficients of the formula from the trends
 * file, fitted on past quotes: perhaps on these very records of source
 * "devis", where the error of the formula is then a fitting error, not one of
 * a prediction (and the AI is given the formula's value).
 */
export function backtestReading(s, { tendance = false } = {}) {
  const t = s.total;
  const out = [];
  if (t.n) {
    const sources = [t.devis && plural(t.devis, "temps de devis", "temps de devis"), t.production && plural(t.production, "temps mesuré en production", "temps mesurés en production")].filter(Boolean).join(", ");
    out.push(`Sur ${plural(t.n, "pièce chiffrée", "pièces chiffrées")} (${sources}), l'IA s'écarte en moyenne de ${pct(t.ia.emap)} du temps de référence${t.formule ? `, la formule de ${pct(t.formule.emap)}` : ""}${t.formule && t.formule.n < t.n ? ` (sur ${t.formule.n} : îlot absent de Paramètres pour les autres)` : ""}.`);
    out.push(`Le temps de référence est dans la fourchette de l'IA pour ${t.dedans} pièce${t.dedans > 1 ? "s" : ""} sur ${t.n} (${pct(t.dedans / t.n, 0)}).`);
    const measured = s.sources.find((x) => x.source === "production");
    if (measured && t.devis) out.push(`Sur les seuls temps mesurés (${measured.n}) : l'IA ${pct(measured.ia.emap)}${measured.formule ? `, la formule ${pct(measured.formule.emap)}` : ""}.`);
    if (t.devis) {
      out.push("Les temps « devis » sont des estimations des chiffreurs, pas des mesures : l'écart à un temps de devis compare deux estimations ; seuls les temps « production » mesurent l'exactitude.");
      out.push(`${tendance ? "La formule (coefficients du fichier de tendances) a pu être calée sur ces mêmes devis : son écart y est alors" : "Si les coefficients de la formule ont été calés sur ces mêmes devis, son écart y est"} un écart d'ajustement, pas de prévision. L'IA reçoit aussi la valeur de la formule.`);
    }
  }
  if (s.erreurs) out.push(`Pas d'estimation utilisable pour ${plural(s.erreurs, "pièce")} (voir le tableau).`);
  if (s.restantes) out.push(`${plural(s.restantes, "pièce reste", "pièces restent")} à estimer.`);
  return out.join(" ");
}

// A text cell: quoted; one starting with = + - @ would be run as a formula by a spreadsheet (references come from files).
const csvText = (v) => `"${(/^[=+\-@\t\r]/.test(String(v)) ? `'${v}` : String(v)).replace(/"/g, '""')}"`;
const csvNumber = (v) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10).replace(".", ",") : "");

/** The rows (backtestRows) as CSV for a spreadsheet in French: ";" between the cells, a decimal comma. */
export function backtestCsv(rows) {
  const head = ["reference", "ilot", "source", "temps_reference_s", "formule_s", "ecart_formule_pct", "ia_s", "ia_min_s", "ia_max_s", "ecart_ia_pct", "dans_fourchette", "confiance", "fournisseur", "modele", "date", "erreur"];
  const lines = rows.map((x) => {
    const r = x.resultat ?? {};
    return [
      csvText(x.record.ref ?? ""), csvText(x.record.ilot), csvText(x.record.source),
      csvNumber(x.reference), csvNumber(x.formule?.valeur), csvNumber(x.formule ? x.formule.ecart * 100 : null),
      csvNumber(x.ia?.valeur), csvNumber(x.ia?.min), csvNumber(x.ia?.max), csvNumber(x.ia ? x.ia.ecart * 100 : null),
      x.ia ? (x.ia.dedans ? "oui" : "non") : "",
      ...[r.confiance, r.fournisseur, r.modele, r.date, r.erreur].map((v) => (v ? csvText(v) : "")),
    ].join(";");
  });
  return `${[head.join(";"), ...lines].join("\r\n")}\r\n`;
}
