// The side panel of the "3D analysis" page, condensed at will: each card folds
// to its title (the chevron, or a click on the title), and the panel is made
// wider or narrower by dragging the splitter between the 3D view and it. Both
// are remembered in this browser. Only classes and the panel's width change:
// app.js keeps showing, hiding and filling the cards as before, and a card
// shown later (after an analysis) keeps the state it was left in.

import { locale, t } from "./i18n.js";

const COLLAPSED_KEY = "reader3d.panel.collapsed"; // ids of the cards folded
const WIDTH_KEY = "reader3d.panel.width"; // width of the panel chosen by dragging (px)
const DEFAULT_WIDTH = 380; // .layout of style.css
const MIN_WIDTH = 260;
const MAX_SHARE = 0.6; // of the page's width
const MIN_VIEW = 320; // what is left to the 3D view at least
const STEP = 20; // arrow keys on the splitter (Shift: BIG_STEP)
const BIG_STEP = 80;
// The panel under the 3D view (style.css): no splitter, no width of its own.
const STACKED = window.matchMedia("(max-width: 900px)");

// The key value of a card, beside its title while it is folded.
const PEEKS = { "summary-card": "total-volume", "mass-card": "mass", "thickness-card": "thick-min" };

function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // no storage: nothing remembered
  }
}

function save(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // not remembered: fine
  }
}

const layout = document.getElementById("page-viewer");
const panel = layout?.querySelector(":scope > .panel");

// ------------------------------------------------------------ folded cards

const collapsed = new Set();
try {
  const saved = JSON.parse(load(COLLAPSED_KEY));
  if (Array.isArray(saved)) for (const id of saved) if (typeof id === "string") collapsed.add(id);
} catch {
  // nothing folded
}

const cards = () => [...panel.querySelectorAll(":scope > section.card[id]")];
const parts = (card) => {
  const head = card.querySelector(":scope > .card-head");
  return {
    head,
    toggle: head?.querySelector(":scope > .card-toggle"),
    title: head?.querySelector(":scope > h3"),
    peek: head?.querySelector(":scope > .card-peek"),
  };
};

// Every write below is skipped when nothing changes: the panel is watched for
// changes (cards shown or filled), and a write of the same value is one too.
function setHidden(el, hidden) {
  if (el && el.hidden !== hidden) el.hidden = hidden;
}
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

const listening = new WeakSet(); // the heads listened to: one listener each, even if their content is drawn again

/** A chevron at the start of the card's head; a head made for a card with a bare title (the mass). */
function enhance(card) {
  let head = card.querySelector(":scope > .card-head");
  if (!head) {
    const title = card.querySelector(":scope > h3");
    if (!title) return;
    head = document.createElement("div");
    head.className = "card-head";
    title.replaceWith(head);
    head.append(title);
  }
  if (head.querySelector(":scope > .card-toggle")) return;
  const title = head.querySelector(":scope > h3");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "card-toggle";
  toggle.setAttribute("aria-controls", card.id);
  if (title) {
    title.id ||= `${card.id}-title`;
    toggle.setAttribute("aria-labelledby", title.id);
  }
  toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 6l4 4 4-4"/></svg>';
  head.prepend(toggle);
  if (PEEKS[card.id]) {
    const peek = document.createElement("span");
    peek.className = "card-peek";
    peek.hidden = true;
    (title ?? toggle).after(peek);
  }
  head.classList.add("card-head-toggle");
  card.classList.add("card-collapsible");
  // The chevron, the title, the value beside it or the free space of the head:
  // its controls (checkboxes, buttons, lists) do what they do, nothing more.
  if (!listening.has(head)) {
    listening.add(head);
    head.addEventListener("click", (e) => {
      const { toggle, title, peek } = parts(card);
      if (e.target === head || [toggle, title, peek].some((el) => el?.contains(e.target))) setCollapsed(card, !card.classList.contains("is-collapsed"));
    });
  }
  setCollapsed(card, collapsed.has(card.id), false);
}

function setCollapsed(card, on, remember = true) {
  const { toggle } = parts(card);
  // Folded: a mode of the 3D view started from the card's body (a face to pick or
  // reassign, a riser or the ingate to place) stops, as its button and its hint
  // go out of sight; a click on the view then selects again. Its button clicked
  // once more is what turns it off (app.js).
  if (on) for (const button of card.querySelectorAll(":scope > :not(.card-head) button.toggle.active")) button.click();
  card.classList.toggle("is-collapsed", on);
  toggle.setAttribute("aria-expanded", String(!on));
  toggle.dataset.i18nTitle = on ? "panel.expand" : "panel.collapse";
  toggle.title = t(toggle.dataset.i18nTitle);
  if (remember) {
    if (on) collapsed.add(card.id);
    else collapsed.delete(card.id);
    save(COLLAPSED_KEY, collapsed.size ? JSON.stringify([...collapsed]) : null);
  }
  refreshPeek(card);
  refreshTools();
}

/** The value beside the title, and what it is when the card says so in another way (its tooltip). */
function peekOf(card) {
  const source = document.getElementById(PEEKS[card.id]);
  if (!source || source.closest("[hidden]")) return { text: "" };
  // The thinnest wall typed in for the quote (the one detected is then greyed in
  // the card): the one the costing uses.
  if (card.id === "thickness-card" && source.classList.contains("overridden")) {
    const used = parseFloat(document.getElementById("thick-min-used")?.value);
    if (used > 0) return { text: `${used.toLocaleString(locale(), { maximumFractionDigits: 2 })} mm`, title: t("thick.minUsed") };
  }
  return { text: source.textContent.trim() };
}

function refreshPeek(card) {
  const { head, peek } = parts(card);
  if (!peek) return;
  const { text, title = "" } = peekOf(card);
  const shown = card.classList.contains("is-collapsed") && text !== "" && text !== "—";
  setText(peek, text);
  if (peek.title !== title) peek.title = title;
  setHidden(peek, !shown);
  head.classList.toggle("has-peek", shown);
}

// "Collapse all" / "Expand all", above the cards when two or more are shown.
const tools = document.createElement("div");
tools.className = "panel-tools";
tools.hidden = true;
const foldAll = document.createElement("button");
foldAll.type = "button";
foldAll.className = "linklike small panel-fold-all";
tools.append(foldAll);

foldAll.addEventListener("click", () => {
  const fold = cards().some((card) => !card.hidden && !card.classList.contains("is-collapsed"));
  for (const card of cards()) if (card.classList.contains("card-collapsible")) setCollapsed(card, fold);
});

function refreshTools() {
  const shown = cards().filter((card) => !card.hidden && card.classList.contains("card-collapsible"));
  setHidden(tools, shown.length < 2);
  const key = shown.length && shown.every((card) => card.classList.contains("is-collapsed")) ? "panel.expandAll" : "panel.collapseAll";
  if (foldAll.dataset.i18n !== key) foldAll.dataset.i18n = key;
  setText(foldAll, t(key));
}

function refresh() {
  for (const card of cards()) {
    enhance(card);
    refreshPeek(card);
  }
  refreshTools();
}

// ------------------------------------------------------------ panel width

const splitter = document.createElement("div");
splitter.className = "panel-splitter";
splitter.tabIndex = 0;
splitter.setAttribute("role", "separator");
splitter.setAttribute("aria-orientation", "vertical");
splitter.dataset.i18nTitle = "panel.resize.title";

let preferred = null; // the width chosen (px), or null: the default one
{
  const saved = Number(load(WIDTH_KEY));
  if (Number.isFinite(saved) && saved > 0) preferred = saved;
}

/** The widths the panel may take in this window: never so wide that the 3D view is cramped. */
function limits() {
  const total = layout.clientWidth;
  return { min: MIN_WIDTH, max: Math.max(MIN_WIDTH, Math.floor(Math.min(total * MAX_SHARE, total - MIN_VIEW))) };
}

const clamp = (width) => {
  const { min, max } = limits();
  return Math.round(Math.min(max, Math.max(min, width)));
};

/** The preferred width, within the limits of the window as it is now. */
function applyWidth() {
  // The page hidden (another tab of the bar) or the panel under the view: nothing to fit.
  if (!layout.clientWidth || STACKED.matches) return;
  const width = clamp(preferred ?? DEFAULT_WIDTH);
  if (preferred == null && width === DEFAULT_WIDTH) layout.style.removeProperty("--panel-width");
  else layout.style.setProperty("--panel-width", `${width}px`);
  const { min, max } = limits();
  splitter.setAttribute("aria-valuemin", String(min));
  splitter.setAttribute("aria-valuemax", String(max));
  splitter.setAttribute("aria-valuenow", String(width));
  splitter.setAttribute("aria-valuetext", `${width} px`);
}

function setWidth(width, remember) {
  preferred = clamp(width);
  applyWidth();
  if (remember) save(WIDTH_KEY, String(preferred));
}

function resetWidth() {
  preferred = null;
  save(WIDTH_KEY, null);
  applyWidth();
}

const currentWidth = () => Math.round(panel.getBoundingClientRect().width);

// Dragged: the panel's edge follows the pointer, once per frame (the 3D view is
// drawn again at its new size, app.js). A click that does not move it changes
// nothing: the width chosen stays the one kept, also while the window is too
// narrow for it (the panel then shown narrower, wider again with the window).
const DRAG_START = 2; // px the pointer moves before the edge follows it
let drag = null;
splitter.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || STACKED.matches) return;
  // (No preventDefault: the click focuses the splitter for the arrow keys, without its focus ring.)
  splitter.setPointerCapture(e.pointerId);
  const right = layout.getBoundingClientRect().right;
  drag = { id: e.pointerId, x0: e.clientX, x: e.clientX, grab: right - e.clientX - currentWidth(), frame: 0, moved: false };
  document.documentElement.classList.add("panel-resizing");
});

const dragTo = (x) => setWidth(layout.getBoundingClientRect().right - x - drag.grab, false);

splitter.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.x = e.clientX;
  drag.moved ||= Math.abs(drag.x - drag.x0) >= DRAG_START;
  if (!drag.moved) return;
  drag.frame ||= requestAnimationFrame(() => {
    if (!drag) return;
    drag.frame = 0;
    dragTo(drag.x);
  });
});

function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  cancelAnimationFrame(drag.frame);
  const { moved } = drag;
  if (moved && e.type === "pointerup") dragTo(e.clientX);
  drag = null;
  document.documentElement.classList.remove("panel-resizing");
  if (splitter.hasPointerCapture(e.pointerId)) splitter.releasePointerCapture(e.pointerId);
  if (moved && preferred != null) save(WIDTH_KEY, String(preferred));
}
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) splitter.addEventListener(type, endDrag);

splitter.addEventListener("dblclick", resetWidth);

// ← widens the panel (the splitter goes left), → narrows it; Home / End: its
// narrowest / widest; Enter: the default width.
splitter.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || STACKED.matches) return;
  const step = e.shiftKey ? BIG_STEP : STEP;
  const width = currentWidth();
  const next = { ArrowLeft: width + step, ArrowRight: width - step, Home: limits().min, End: limits().max }[e.key];
  if (e.key === "Enter") resetWidth();
  else if (next !== undefined) setWidth(next, true);
  else return;
  e.preventDefault();
});

// ------------------------------------------------------------ labels, start

function label() {
  splitter.setAttribute("aria-label", t("panel.resize"));
  splitter.title = t("panel.resize.title");
  for (const card of cards()) {
    const { toggle } = parts(card);
    if (toggle) toggle.title = t(toggle.dataset.i18nTitle);
    refreshPeek(card);
  }
  setText(foldAll, t(foldAll.dataset.i18n || "panel.collapseAll"));
}

if (panel) {
  panel.id ||= "viewer-panel";
  splitter.setAttribute("aria-controls", panel.id);
  panel.before(splitter);
  panel.prepend(tools);
  refresh();
  label();
  applyWidth();
  // Cards shown, hidden, added or filled by app.js.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      refresh();
    });
  }).observe(panel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
  // The language changed (i18n.js applyToPage sets <html lang>).
  new MutationObserver(label).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  // A window resized: the width chosen, within the new limits.
  new ResizeObserver(applyWidth).observe(layout);
  STACKED.addEventListener("change", applyWidth);
}
