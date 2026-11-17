/* IITD Mailer front end. No framework: one state object, render functions per screen. */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : (many || one + "s")}`;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem("iitdmailer:" + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("iitdmailer:" + k, JSON.stringify(v)); } catch {} },
};

const FIELDS = [["to", "To", true], ["subject", "Subject", true], ["body", "Body", true], ["cc", "CC"], ["bcc", "BCC"], ["reply_to", "Reply-to"], ["attachments", "Attachments"]];
const IMAP = { iitd: "mailstore.iitd.ac.in", gmail: "imap.gmail.com", custom: "" };
const PROV = { iitd: { host: "smtp.iitd.ac.in", port: 465 }, gmail: { host: "smtp.gmail.com", port: 465 }, custom: { host: "", port: 587 } };
const ICON = {
  file: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5l3 3v10h-8.5z"/><path d="M9.5 1.5v3h3"/></svg>',
  prev: '<svg viewBox="0 0 14 14"><path d="M9 2.5L4.5 7 9 11.5"/></svg>',
  next: '<svg viewBox="0 0 14 14"><path d="M5 2.5L9.5 7 5 11.5"/></svg>',
  list: '<svg viewBox="0 0 16 16"><path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8"/><circle cx="2.8" cy="4.5" r=".6"/><circle cx="2.8" cy="8" r=".6"/><circle cx="2.8" cy="11.5" r=".6"/></svg>',
};

const S = {
  mode: "local", login: false, account: null, pace: { delay: 5, per_hour: 20 }, testTo: "", dataDir: "",
  lists: [], list: null, checks: [], status: {}, files: [], copies: {},
  filter: "todo", selected: new Set(), cur: 0, showPv: false, mapperOpen: false,
  templates: [], filters: [], msgOpen: false, msgSaveT: null, msgField: "body", filtersOpen: false,
  job: null, allowance: null, route: "list", again: new Set(), renaming: false, renameNext: false, showArchived: false, menuClose: null, pollT: null, pvSeq: 0, logRows: null, logFilter: "all",
};

/* ---------------------------------------------------------------- plumbing */
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = "/login"; throw new Error("Please sign in again."); }
  let j; try { j = await r.json(); } catch { j = { error: `The app replied with an error (${r.status}).` }; }
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function when(s) { const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(s || ""); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]}, ${m[4]}:${m[5]}` : (s || ""); }
const MORE = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="11" cy="7" r="1.2"/></svg>';
const post = (p, b) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });

function toast(msg, kind = "") {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show " + kind;
  clearTimeout(t._t); t._t = setTimeout(() => (t.className = "toast " + kind), kind === "bad" ? 6000 : 3500);
}
function clock(epoch) { return new Date(epoch * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function inWords(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60); if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`;
}
function size(b) { return b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`; }
const jobActive = () => S.job && (S.job.state === "running" || S.job.state === "waiting");

/* ---------------------------------------------------------------- theme + menu */
function setTheme(t) {
  document.documentElement.dataset.theme = t; store.set("theme", t);
  $$("[data-theme-set]").forEach(b => b.classList.toggle("on", b.dataset.themeSet === t));
  if (S.route === "list" && S.list) preview(S.cur);
  if (S.route === "account") renderAccount();
}
$$("[data-theme-set]").forEach(b => (b.onclick = () => setTheme(b.dataset.themeSet)));
$("#menu-open").onclick = () => document.body.classList.add("menu-open");
$("#menu-close").onclick = () => document.body.classList.remove("menu-open");
$("#side").addEventListener("click", e => { if (e.target.closest("a")) document.body.classList.remove("menu-open"); });
$("#side-upload").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadList(f); };

/* ---------------------------------------------------------------- shell */
function renderShell() {
  const acc = S.account;
  $("#side-scope").textContent = acc ? acc.from_email : "Not connected";
  const c = $("#conn");
  c.className = "conn " + (acc?.connected ? "ok" : "bad");
  $("#conn-text").textContent = acc?.connected ? `${acc.host} · connected` : acc ? "Password needed · Account" : "Not connected · Account";
  $("#lists-label").hidden = !S.lists.length;
  const act = S.lists.filter(l => !l.archived), arch = S.lists.filter(l => l.archived);
  const showA = S.showArchived || arch.some(l => l.id === S.list?.id);
  const item = l => {
    const sending = jobActive() && S.job.list_id === l.id;
    const on = ["list", "history"].includes(S.route) && S.list?.id === l.id;
    const pct = l.count ? Math.round((100 * l.sent) / l.count) : 0;
    const sub = sending ? `<span class="dot" aria-hidden="true"></span>Sending · ${l.sent.toLocaleString()} of ${l.count.toLocaleString()}`
      : l.sent >= l.count ? `All ${l.count.toLocaleString()} sent` : l.sent ? `${l.sent.toLocaleString()} of ${l.count.toLocaleString()} sent` : `Not sent yet · ${plural(l.count, "row")}`;
    return `<div class="li ${on ? "on" : ""}"><a href="#/list/${l.id}" class="li-a" title="${esc(l.filename)}"${on ? ' aria-current="page"' : ""}><span class="t">${esc(l.name)}</span><span class="li-sub">${sub}</span><span class="li-bar"><i style="width:${pct}%"></i></span></a><button class="li-more" data-more="${l.id}" aria-label="More for ${esc(l.name)}" aria-haspopup="menu">${MORE}</button></div>`;
  };
  $("#side-lists").innerHTML = act.map(item).join("")
    + (arch.length ? `<button class="arch-toggle" id="arch-toggle" aria-expanded="${showA}">${showA ? "Hide archived" : `Archived (${arch.length})`}</button>${showA ? arch.map(item).join("") : ""}` : "");
  $$("#side-lists [data-more]").forEach(b => (b.onclick = e => { e.preventDefault(); listMenu(b); }));
  const at = $("#arch-toggle"); if (at) at.onclick = () => { S.showArchived = !showA; renderShell(); };
  $$(".nav a[data-route]").forEach(a => a.classList.toggle("on", a.dataset.route === S.route));
  const crumbs = { log: "Sent log", files: "Attachments", account: "Account" };
  $("#crumbs").innerHTML = S.route === "history" ? `<span>Lists</span><span>/</span><span>${esc(S.list?.name || "")}</span><span>/</span><b>History</b>` : S.route === "list"
    ? (S.list ? `<span>Lists</span><span>/</span><b>${esc(S.list.name)}</b>` : `<span>Lists</span><span>/</span><b>New list</b>`)
    : `<b>${crumbs[S.route]}</b>`;
  $$("[data-theme-set]").forEach(b => b.classList.toggle("on", b.dataset.themeSet === document.documentElement.dataset.theme));
}

/* ---------------------------------------------------------------- routing */
async function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [r, id, extra] = h.split("/");
  closeMenu();
  S.route = ["log", "files", "account", "history"].includes(r) ? r : "list";
  if (["list", "history"].includes(S.route) && id && id !== S.list?.id) {
    try { const j = await api(`/api/lists/${id}`); setList(j.list); } catch (e) { toast(e.message, "bad"); }
  }
  if (S.route === "list" && extra !== undefined && S.list) {       // #/list/<id>/<row>: open that row
    const n = +extra; if (n >= 0 && n < S.list.count) { S.cur = n; S.showPv = true; S.filter = "all"; }
  }
  renderShell();
  ({ list: renderList, log: renderLog, files: renderFiles, account: renderAccount, history: renderHistory })[S.route]();
  $("#view").focus({ preventScroll: true });
}
window.addEventListener("hashchange", route);

/* ---------------------------------------------------------------- lists */
function setList(list) {
  S.list = list; S.status = Object.fromEntries(Object.entries(list?.status || {}).map(([k, v]) => [+k, v]));
  S.checks = []; S.cur = 0; S.showPv = false; S.mapperOpen = false; S.filter = "todo"; S.selected = new Set();
  S.again = new Set(list?.again || []); S.renaming = false;
  const m = list?.message || {};
  S.msgOpen = m.mode === "template" && !(m.subject && m.body);     // open the editor until a message exists
  S.filters = (list && store.get("filters:" + list.id)) || []; S.filtersOpen = S.filters.length > 0;
}
async function uploadList(file) {
  const fd = new FormData(); fd.append("file", file);
  try {
    const j = await api("/api/lists", { method: "POST", body: fd });
    S.lists = j.lists; setList(j.list);
    toast(`Loaded ${plural(j.list.count, "row")} from ${j.list.filename}`);
    if (location.hash !== `#/list/${j.list.id}`) location.hash = `#/list/${j.list.id}`; else route();
  } catch (e) { toast(e.message, "bad"); }
}
async function runCheck() {
  if (!S.list) return;
  const j = await api(`/api/lists/${S.list.id}/check`);
  S.checks = j.rows;
  S.status = Object.fromEntries(Object.entries(j.status || {}).map(([k, v]) => [+k, v]));
}
const ERR_SHORT = [[/^Choose which column/, "No To column"], [/^No email address/, "No address"], [/^No valid email/, "Bad address"], [/^Not a valid address/, "Bad address"], [/^Attachment not found/, "File missing"]];
function rowState(i) {
  const j = S.job, active = jobActive() && j.list_id === S.list.id;
  if (active && j.current === i && j.state === "running") return ["Sending", "sending", "sending"];
  const st = S.status[i];
  if (st?.status === "sent") return ["Sent", "sent", "sent"];
  if (active && j.remaining.includes(i)) return ["Queued", "neutral", "queued"];
  const c = S.checks[i];
  if (c?.errors.length) { const m = ERR_SHORT.find(([re]) => re.test(c.errors[0])); return [m ? m[1] : "Problem", "bad", "fix"]; }
  if (c?.before && !S.again.has(i)) return [c.before.kind === "dup" ? "Duplicate" : "Emailed before", "warn", "before"];
  if (c?.before) return ["Send again", "warn", "todo"];
  if (st?.status === "failed") return ["Failed", "bad", "failed"];
  if (st?.status === "unsure") return ["Check inbox", "warn", "failed"];
  if (c?.warnings.length) return ["Check", "warn", "todo"];
  return ["Ready", "ok", "todo"];
}
const sendable = i => { const k = rowState(i)[2]; return k === "todo" || k === "failed"; };
function passes(i) {
  const r = S.list.rows[i] || {};
  return S.filters.every(f => !f.col || f.val == null || (r[f.col] || "").trim() === f.val);
}
function counts(filtered) {
  const n = S.list.count, c = { all: 0, todo: 0, fix: 0, sent: 0, before: 0 };
  for (let i = 0; i < n; i++) { if (filtered && !passes(i)) continue; c.all++; const k = rowState(i)[2]; if (k === "todo" || k === "failed" || k === "queued" || k === "sending") c.todo++; if (k === "fix") c.fix++; if (k === "before") c.before++; if (k === "sent") c.sent++; }
  return c;
}
function visibleRows() {
  const out = [];
  for (let i = 0; i < S.list.count; i++) {
    if (!passes(i)) continue;
    const k = rowState(i)[2];
    if (S.filter === "all" || (S.filter === "todo" && ["todo", "failed", "queued", "sending"].includes(k)) || (S.filter === k)) out.push(i);
  }
  return out;
}
function defaultSelection() { S.selected = new Set([...Array(S.list.count).keys()].filter(sendable)); }

/* ---------------------------------------------------------------- the hourly allowance */
function simulate(n) {
  // When would n more emails go out, given the hourly limit, the gap, and what was sent in the last hour?
  const a = S.allowance, per = S.pace.per_hour, gap = +S.pace.delay || 0;
  let t = a ? a.now : Date.now() / 1000; const q = [...(a?.times || [])]; let last = t;
  for (let k = 0; k < n; k++) {
    while (q.length && q[0] <= t - 3600) q.shift();
    if (per && q.length >= per) { t = q[0] + 3601; continue; }
    q.push(t); last = t; t += gap + 1;
  }
  return last;
}
function allowanceHTML() {
  const a = S.allowance || { sent_last_hour: 0, times: [], now: Date.now() / 1000 };
  const per = +S.pace.per_hour || 0, sent = a.sent_last_hour;
  const queuedJob = jobActive() ? S.job.remaining.length : 0;
  if (!per) {
    return `<section class="panel allow unlimited" aria-label="Sending allowance"><div><h2>Sent in the last 60 minutes</h2><div class="big num">${sent}</div>
      <div class="note">No hourly limit is set. IIT Delhi refused after about 28 in a short time: set one in <a class="link" href="#/account">Account</a>.</div></div><div></div></section>`;
  }
  const left = Math.max(0, per - sent), frees = a.times.length ? a.times[0] + 3600 : null;
  const queued = Math.min(left, queuedJob);
  const cells = Math.min(per, 60);
  const scale = per > 60 ? per / 60 : 1;
  let html = "";
  for (let k = 0; k < cells; k++) {
    const v = k * scale; html += `<i class="${v < sent ? "s" : v < sent + queued ? "q" : ""}"></i>`;
  }
  const note = sent >= per
    ? `<b>Limit reached.</b> The next email can go at ${clock(frees)}.`
    : `<b>${left} left</b> this hour${frees ? ` · the oldest send drops off at ${clock(frees)}` : ""}.`;
  return `<section class="panel allow" aria-label="Sending allowance">
    <div><h2>Sending allowance, last 60 minutes</h2><div class="big num">${sent} <small>of ${per} sent</small></div><div class="note">${note}</div></div>
    <div><div class="slots" style="grid-template-columns:repeat(${cells},minmax(0,1fr))" role="img" aria-label="${sent} of ${per} used, ${queued} queued">${html}</div>
    <div class="slots-scale"><span>Your limit: ${per} an hour</span><span class="slots-key"><span><i style="background:var(--accent)"></i>Sent</span>${queued ? '<span><i style="background:var(--accent-dim)"></i>Queued this hour</span>' : ""}<span><i style="background:var(--raised);outline:1px solid var(--control)"></i>Free</span></span></div></div>
  </section>`;
}

/* ---------------------------------------------------------------- job bar */
function jobHTML() {
  const j = S.job; if (!j) return "";
  const other = S.list && j.list_id !== S.list.id;
  const name = `<a class="link" href="#/list/${j.list_id}">${esc(j.list_name)}</a>`;
  const pct = j.total ? Math.round((100 * j.done) / j.total) : 0;
  let line, why = "", btns = "";
  if (j.state === "running") {
    line = `<b>Sending ${other ? name : ""}</b><span class="num">${j.sent} of ${j.total} sent${j.failed ? ` · ${j.failed} failed` : ""}${j.skipped ? ` · ${j.skipped} skipped` : ""}</span>`;
    why = j.next_at ? `Next email at ${clock(j.next_at)}.` : "Sending now.";
    if (S.mode === "server") why += " This keeps going if you close the page.";
    else why += " Keep this app running until it finishes.";
    btns = `<button class="btn ghost small" data-job="stop">Stop</button>`;
  } else if (j.state === "waiting") {
    line = `<span class="pill warn">Waiting</span><b>Paused until ${clock(j.resume_at)}</b><span>${inWords(j.resume_at - Date.now() / 1000)} from now · ${j.sent} of ${j.total} sent</span>`;
    why = esc(j.wait_reason);
    btns = `<button class="btn small" data-job="retry">Try now</button><button class="btn ghost small" data-job="stop">Stop</button>`;
  } else if (j.state === "paused") {
    line = `<span class="pill bad">Stopped</span><b>Sending stopped</b><span class="num">${j.sent} of ${j.total} sent · ${j.total - j.done} waiting</span>`;
    why = esc(j.error);
    btns = `<button class="btn small" data-job="resume">Resume</button><button class="btn ghost small" data-job="stop">Discard the rest</button>`;
  } else {
    const label = j.state === "stopped" ? "Stopped" : "Finished";
    line = `<b>${label}${other ? " · " + name : ""}</b><span class="num">${j.sent} sent${j.failed ? ` · ${j.failed} failed` : ""}${j.skipped ? ` · ${j.skipped} skipped (emailed before)` : ""}${j.state === "stopped" ? ` · ${j.total - j.done} not sent` : ""}</span>`;
    why = j.failed ? "The failed rows show why in the list and in the Sent log." : `Started ${j.started.slice(11, 16)}.`;
    btns = `<a class="btn ghost small" href="#/log">Sent log</a><button class="btn ghost small" data-job="dismiss">Dismiss</button>`;
  }
  const lost = (j.results || []).filter(r => r.copy === "failed").length;
  if (lost) why += ` ${plural(lost, "copy", "copies")} not saved in Sent${j.copy_error ? `: ${esc(j.copy_error)}` : "."}`;
  return `<section class="panel jobbar ${j.state}" aria-live="polite"><div class="prog"><div class="line">${line}</div><div class="why">${why}</div>
    <div class="bar"><i style="width:${pct}%"></i></div></div>${btns}</section>`;
}
async function jobAction(a) {
  try { const j = await post(`/api/job/${a}`); S.job = j.job; if (a === "stop" || a === "dismiss") await runCheck(); refreshListParts(); poll(true); }
  catch (e) { toast(e.message, "bad"); }
}

/* ---------------------------------------------------------------- list screen */
function renderList() {
  const v = $("#view");
  if (S.renameNext) { S.renaming = true; S.renameNext = false; }
  if (!S.list) { renderFirstRun(); return; }
  v.innerHTML = `
    <div class="head" id="head"></div>
    <section class="panel stripbox" id="strip"></section>
    <section class="panel msgbox" id="msg" aria-label="Message"></section>
    <div id="jobslot"></div>
    <div id="allowslot"></div>
    <div class="work ${S.showPv ? "show-pv" : ""}" id="work">
      <section class="panel list-panel" aria-label="Recipients">
        <div class="panel-h"><h2>Recipients</h2><div class="right"><span class="sel" id="selinfo"></span><button class="btn small" id="filter-toggle" aria-expanded="false">Filter</button></div></div>
        <div class="tabwrap"><div class="tabs" id="tabs" role="tablist"></div></div>
        <div class="filters" id="filters" hidden></div>
        <div class="tablewrap"><table><thead><tr><th class="c"><input type="checkbox" class="cb" id="cb-all" aria-label="Select all shown"></th><th class="n">#</th><th class="to">To</th><th class="subj">Last sent</th><th class="st">Status</th></tr></thead><tbody id="tbody"></tbody></table></div>
        <div class="list-foot" id="listfoot"></div>
      </section>
      <section class="panel pv" id="pv" aria-label="Email preview"></section>
    </div>`;
  if (!S.checks.length) { runCheck().then(() => { if (!S.selected.size) defaultSelection(); if (S.filter === "todo" && !counts().todo) S.filter = "all"; refreshListParts(); preview(S.cur); }).catch(e => toast(e.message, "bad")); }
  else refreshListParts();
  renderStrip();
  renderMessage();
  preview(S.cur);
}
function refreshListParts() {
  if (S.route !== "list" || !S.list || !$("#head")) return;
  if (!S.renaming) renderHead();     // don't wipe the rename box while someone types
  renderTable(); renderFilters();
  $("#jobslot").innerHTML = jobHTML(); $("#allowslot").innerHTML = allowanceHTML();
  $$("#jobslot [data-job]").forEach(b => (b.onclick = () => jobAction(b.dataset.job)));
  renderShell();
}
function renderHead() {
  const c = counts(), probs = [];
  for (let i = 0; i < S.list.count && probs.length < 2; i++) { const s = rowState(i); if (s[2] === "fix") probs.push(`row ${i + 1}: ${s[0].toLowerCase()}`); }
  let sub;
  if (!S.checks.length) sub = `Checking ${plural(S.list.count, "row")}…`;
  else if (c.sent === c.all) sub = `<b>All ${plural(c.all, "email")} sent.</b>`;
  else {
    sub = `<b>${c.todo} to send</b>`;
    if (c.fix) sub += ` · <span class="bad">${c.fix} need fixing</span> (${probs.join(", ")}${c.fix > 2 ? ", …" : ""})`;
    if (c.sent) sub += ` · ${c.sent} already sent`;
  }
  const n = [...S.selected].filter(sendable).length;
  const busy = jobActive();
  const title = S.renaming
    ? `<form class="title-edit" id="ren-form"><label class="sr" for="ren-in">List name</label><input id="ren-in" value="${esc(S.list.name)}" maxlength="80" autocomplete="off"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="ren-cancel">Cancel</button></form>`
    : `<div class="h1row"><h1 id="list-title" title="Click to rename">${esc(S.list.name)}</h1><button class="link quiet" id="ren-btn">Rename</button></div>`;
  $("#head").innerHTML = `<div class="head-main">${title}<p class="sub">${sub}</p></div>
    <div class="acts">
      <button class="btn" id="btn-hist">History</button>
      <button class="btn" id="btn-test" ${S.account ? "" : "disabled title='Connect your account first'"}>Send test to me</button>
      ${busy && S.job.list_id === S.list.id ? `<button class="btn ghost" data-job="stop">Stop sending</button>`
      : `<button class="btn primary" id="btn-send" ${!n || busy || !S.account?.connected ? "disabled" : ""} title="${!S.account?.connected ? "Connect your account in Account first" : busy ? "Another list is sending" : ""}">Send ${plural(n, "email")}</button>`}
    </div>`;
  $("#btn-test").onclick = sendTest;
  $("#btn-hist").onclick = () => (location.hash = `#/history/${S.list.id}`);
  const rb = $("#ren-btn"); if (rb) rb.onclick = $("#list-title").onclick = () => { S.renaming = true; renderHead(); };
  const rf = $("#ren-form");
  if (rf) {
    const inp = $("#ren-in"); inp.focus(); inp.select();
    const stop = () => { S.renaming = false; renderHead(); };
    inp.onkeydown = e => { if (e.key === "Escape") stop(); };
    $("#ren-cancel").onclick = stop;
    rf.onsubmit = async e => { e.preventDefault(); await renameList(S.list.id, inp.value); stop(); };
  }
  const sb = $("#btn-send"); if (sb) sb.onclick = confirmSend;
  $$("#head [data-job]").forEach(b => (b.onclick = () => jobAction(b.dataset.job)));
}
/* ---------------------------------------------------------------- one message for everyone */
const NAME_CHIPS = [["Greeting name", "Dr. Bao or Professor Adjiman"], ["First name", ""], ["Last name", ""]];
function renderMessage() {
  const box = $("#msg"); if (!box || !S.list) return;
  const g = S.list.message || { mode: "csv" }, templ = g.mode === "template", m = S.list.mapping || {};
  const busy = jobActive() && S.job.list_id === S.list.id;
  if (!S.msgOpen) {
    const sum = templ
      ? (g.subject || g.body ? `<b>Same for everyone</b><span class="msg-subj">${esc(g.subject || "No subject yet")}</span>` : `<b class="bad">No message yet</b>`)
      : `<b>From CSV columns</b><span class="msg-subj">Subject ← ${esc(m.subject || "none")}, Body ← ${esc(m.body || "none")}</span>`;
    box.innerHTML = `<div class="msg-sum"><span class="msg-k">Message</span>${sum}<button class="link" id="msg-open">${templ ? "Edit message" : "Write one message for everyone"}</button></div>`;
    $("#msg-open").onclick = () => { S.msgOpen = true; if (!templ) saveMessage({ mode: "template" }, true); renderMessage(); };
    return;
  }
  const r = S.list.rows[S.cur] || {};
  const nameOpts = S.list.columns.map(c => `<option ${g.name_col === c ? "selected" : ""}>${esc(c)}</option>`).join("");
  box.innerHTML = `<div class="panel-h"><h2>Message</h2>
      <div class="seg" id="msg-mode">${[["template", "Same for everyone"], ["csv", "From CSV columns"]].map(([k, l]) => `<button type="button" data-mode="${k}" class="${g.mode === k ? "on" : ""}" ${busy ? "disabled" : ""}>${l}</button>`).join("")}</div>
      <div class="right"><span class="faint msg-state" id="msg-state" aria-live="polite"></span>${templ ? `<button class="btn small" id="tpl-load">Templates${S.templates.length ? ` <span class="num faint">${S.templates.length}</span>` : ""}</button><button class="btn small" id="tpl-save">Save as template</button>` : ""}<button class="btn small primary" id="msg-done">Done</button></div></div>
    ${templ ? `<div class="msg-grid">
      <div class="msg-edit">
        <label class="f" for="msg-subject">Subject</label><input type="text" id="msg-subject" value="${esc(g.subject || "")}" placeholder="Prospective summer research intern from IIT Delhi" ${busy ? "disabled" : ""}>
        <label class="f" for="msg-body">Message</label><textarea id="msg-body" rows="16" spellcheck="true" placeholder="Dear {Greeting name},&#10;&#10;I am a … student at IIT Delhi …" ${busy ? "disabled" : ""}>${esc(g.body || "")}</textarea>
        <p class="hint">${busy ? "This list is sending, so the message is locked until it stops." : "Plain text: line breaks are kept as you type them. Saved as you type. The preview on the right shows it for the selected row."}</p>
      </div>
      <aside class="msg-side">
        <h3>Insert</h3>
        <p class="hint">Click to insert at the cursor.</p>
        <div class="chips">${NAME_CHIPS.map(([k]) => `<button class="chip strong" type="button" data-ins="${k}">{${k}}</button>`).join("")}</div>
        <div class="chips">${S.list.columns.filter(c => c !== m.to && !/^(greeting name|first name|last name)$/i.test(c)).map(c => `<button class="chip" type="button" data-ins="${esc(c)}">{${esc(c)}}</button>`).join("")}</div>
        <h3>Names</h3>
        <label class="f">Taken from<select id="msg-namecol"><option value="">Choose a column</option>${nameOpts}</select></label>
        <div class="f"><span>If Dr or Professor is unclear, say</span><div class="seg" id="msg-fallback">${[["Dr.", "Dr."], ["Professor", "Professor"], ["name", "Full name"]].map(([k, l]) => `<button type="button" data-fb="${k}" class="${(g.fallback || "Dr.") === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
        <p class="hint" id="msg-example"></p>
      </aside>
    </div>` : `<p class="msg-csv">Each row's subject and body come from its own columns: Subject ← <b>${esc(m.subject || "none")}</b>, Body ← <b>${esc(m.body || "none")}</b>. Change them under <button class="link" id="msg-cols">Change columns</button>.</p>`}`;
  $$("#msg-mode [data-mode]").forEach(b => (b.onclick = () => saveMessage({ mode: b.dataset.mode }, true)));
  $("#msg-done").onclick = async () => { await flushMessage(); S.msgOpen = false; renderMessage(); };
  const mc = $("#msg-cols"); if (mc) mc.onclick = () => { S.mapperOpen = true; renderStrip(); $("#strip").scrollIntoView({ block: "nearest" }); };
  if (!templ) return;
  const sub = $("#msg-subject"), body = $("#msg-body");
  sub.onfocus = () => (S.msgField = "subject"); body.onfocus = () => (S.msgField = "body");
  const typed = () => { S.list.message = { ...S.list.message, subject: sub.value, body: body.value }; queueMessage(); };
  sub.oninput = typed; body.oninput = typed;
  $$("#msg [data-ins]").forEach(b => (b.onmousedown = e => e.preventDefault()));
  $$("#msg [data-ins]").forEach(b => (b.onclick = () => {
    const el = S.msgField === "subject" ? sub : body, ins = `{${b.dataset.ins}}`;
    const a = el.selectionStart ?? el.value.length, z = el.selectionEnd ?? a;
    el.value = el.value.slice(0, a) + ins + el.value.slice(z); el.focus(); el.selectionStart = el.selectionEnd = a + ins.length; typed();
  }));
  $("#msg-namecol").onchange = e => saveMessage({ name_col: e.target.value || null }, true);
  $$("#msg-fallback [data-fb]").forEach(b => (b.onclick = () => saveMessage({ fallback: b.dataset.fb }, true)));
  $("#tpl-load").onclick = openTemplates; $("#tpl-save").onclick = saveTemplate;
  showExample();
}
async function showExample() {
  const ex = $("#msg-example"); if (!ex || !S.list) return;
  const g = S.list.message || {};
  if (!g.name_col) { ex.textContent = "Choose the column with the names to use {Greeting name}."; return; }
  const r = S.list.rows[S.cur] || {};
  ex.innerHTML = S.pvGreeting
    ? `Row ${S.cur + 1}, ${esc(r[g.name_col] || "")}: <b>Dear ${esc(S.pvGreeting)}</b>`
    : `Write <b>{Greeting name}</b> to get “Dr. Bao” or “Professor Adjiman”, worked out from each name.`;
}
function queueMessage() {
  const st = $("#msg-state"); if (st) st.textContent = "Saving…";
  clearTimeout(S.msgSaveT); S.msgSaveT = setTimeout(() => saveMessage({}, false), 700);
}
async function flushMessage() { if (S.msgSaveT) { clearTimeout(S.msgSaveT); S.msgSaveT = null; await saveMessage({}, false); } }
async function saveMessage(change, redraw) {
  S.msgSaveT = null;
  const g = { ...(S.list.message || {}), ...change };
  S.list.message = g;
  try {
    await post(`/api/lists/${S.list.id}/config`, { message: g });
    const st = $("#msg-state"); if (st) st.textContent = "Saved";
    if (redraw) { renderMessage(); renderStrip(); }
    await runCheck(); if (!S.selected.size) defaultSelection(); refreshListParts(); preview(S.cur);
  } catch (e) { toast(e.message, "bad"); }
}
function openTemplates() {
  const body = S.templates.length
    ? `<p>Using one replaces this list's subject and message.</p><div class="tpls">${S.templates.map(x => `<div class="tpl"><div><b>${esc(x.name)}</b><span class="faint">${esc(when(x.saved))}</span><p>${esc((x.subject || "No subject").slice(0, 90))}</p></div><button class="btn small" data-use="${x.id}">Use</button><button class="link quiet" data-del="${x.id}">Delete</button></div>`).join("")}</div>`
    : `<p>No saved templates yet. Write a message, then choose <b>Save as template</b> to reuse it for your next list.</p>`;
  const d = dialog("Templates", body, "Close", () => {}, false, "wide");
  $$("[data-use]", d.el).forEach(b => (b.onclick = async () => {
    const x = S.templates.find(y => y.id === b.dataset.use); d.close();
    await saveMessage({ mode: "template", subject: x.subject, body: x.body }, true); toast(`Using “${x.name}”`);
  }));
  $$("[data-del]", d.el).forEach(b => (b.onclick = async () => {
    try { const j = await api(`/api/templates/${b.dataset.del}`, { method: "DELETE" }); S.templates = j.templates; d.close(); openTemplates(); renderMessage(); }
    catch (e) { toast(e.message, "bad"); }
  }));
}
function saveTemplate() {
  const g = S.list.message || {};
  if (!(g.subject || g.body)) { toast("Write a message first", "bad"); return; }
  const d = dialog("Save as template", `<p>Saves this subject and message so any list can use it. A template with the same name is updated.</p>
    <label class="f">Name<input type="text" id="tpl-name" value="${esc(S.list.name)}" maxlength="80"></label>`, "Save template", async el => {
    try { const j = await post("/api/templates", { name: $("#tpl-name", el).value, subject: g.subject, body: g.body }); S.templates = j.templates; renderMessage(); toast("Template saved"); }
    catch (e) { toast(e.message, "bad"); }
  });
  const inp = $("#tpl-name", d.el); inp.focus(); inp.select();
}

/* ---------------------------------------------------------------- filters (show only rows where a column has a value) */
function distinct(colName) {
  const n = new Map();
  for (const r of S.list.rows) { const v = (r[colName] || "").trim(); n.set(v, (n.get(v) || 0) + 1); }
  return [...n].sort((a, b) => b[1] - a[1]);
}
function filterCols() { const m = S.list.mapping || {}; return S.list.columns.filter(c => c !== m.to && !/greeting|salutation/i.test(c) && distinct(c).length <= 40 && distinct(c).length > 1); }
function renderFilters() {
  const box = $("#filters"), tg = $("#filter-toggle"); if (!box) return;
  const cols = filterCols();
  tg.hidden = !cols.length;
  tg.textContent = S.filters.length ? `Filter (${S.filters.length})` : "Filter";
  tg.setAttribute("aria-expanded", String(S.filtersOpen));
  tg.onclick = () => { S.filtersOpen = !S.filtersOpen; if (S.filtersOpen && !S.filters.length) S.filters = [{ col: cols[0], val: null }]; renderFilters(); };
  box.hidden = !S.filtersOpen;
  if (!S.filtersOpen) return;
  const match = visibleRowsAll(), ready = match.filter(sendable);
  box.innerHTML = S.filters.map((f, k) => `<div class="frow"><span class="faint">${k ? "and" : "Where"}</span>
      <select data-fc="${k}" aria-label="Column">${cols.map(c => `<option ${f.col === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
      <span class="faint">is</span>
      <select data-fv="${k}" aria-label="Value"><option value="">Choose…</option>${distinct(f.col).map(([v, n]) => `<option value="${esc(v)}" ${f.val === v ? "selected" : ""}>${esc(v ? (v.length > 48 ? v.slice(0, 46) + "…" : v) : "(empty)")} · ${n}</option>`).join("")}</select>
      <button class="link quiet" data-fx="${k}" aria-label="Remove this filter">Remove</button></div>`).join("")
    + `<div class="frow foot"><button class="link quiet" id="f-add">Add another</button><span class="faint">${plural(match.length, "row")} match</span>
       <button class="btn small" id="f-sel" ${ready.length ? "" : "disabled"}>Select the ${ready.length} ready to send</button><button class="link quiet" id="f-clear">Clear filters</button></div>`;
  $$("[data-fc]", box).forEach(s => (s.onchange = () => { S.filters[+s.dataset.fc] = { col: s.value, val: null }; filtersChanged(); }));
  $$("[data-fv]", box).forEach(s => (s.onchange = () => { S.filters[+s.dataset.fv].val = s.value === "" && !s.selectedOptions[0].textContent.startsWith("(empty)") ? null : s.value; filtersChanged(); }));
  $$("[data-fx]", box).forEach(b => (b.onclick = () => { S.filters.splice(+b.dataset.fx, 1); if (!S.filters.length) S.filtersOpen = false; filtersChanged(); }));
  $("#f-add").onclick = () => { S.filters.push({ col: cols.find(c => !S.filters.some(f => f.col === c)) || cols[0], val: null }); filtersChanged(); };
  $("#f-clear").onclick = () => { S.filters = []; S.filtersOpen = false; filtersChanged(); };
  $("#f-sel").onclick = () => { S.selected = new Set(ready); renderTable(); renderHead(); renderFilters(); toast(`Selected ${plural(ready.length, "row")}. Only these are sent.`); };
}
function visibleRowsAll() { const out = []; for (let i = 0; i < S.list.count; i++) if (passes(i)) out.push(i); return out; }
function filtersChanged() { store.set("filters:" + S.list.id, S.filters.filter(f => f.val != null)); renderTable(); renderFilters(); }

function renderStrip() {
  const m = S.list.mapping || {}, o = S.list.opts || {};
  const show = [["to", "To"], ["subject", "Subject"], ["body", "Body"], ["attachments", "Attachments"]];
  const templ = (S.list.message || {}).mode === "template";
  const maps = show.filter(([f]) => (m[f] || ["to", "subject", "body"].includes(f)) && !(templ && ["subject", "body"].includes(f)))
    .map(([f, l]) => `<span class="m map ${m[f] ? "" : "miss"}">${l} ← <b>${m[f] ? esc(m[f]) : "choose a column"}</b></span>`).join("")
    + (templ ? `<span class="m">Subject and body ← <b>one message for everyone</b></span>` : "")
    + ((o.attach || []).length ? `<span class="m">Attached to all: <b>${o.attach.map(esc).join(", ")}</b></span>` : "");
  $("#strip").innerHTML = `<div class="strip-row"><span class="file">${ICON.file}${esc(S.list.filename)}</span><span class="m num">${plural(S.list.count, "row")} · ${plural(S.list.columns.length, "column")}</span>${maps}
    <span class="strip-acts"><button class="link" id="replace-btn">Replace CSV</button><input type="file" id="replace-up" accept=".csv,text/csv,.txt" hidden><button class="link" id="attach-open">Attach files</button><button class="link" id="mapper-toggle" aria-expanded="${S.mapperOpen}">${S.mapperOpen ? "Done" : "Change columns"}</button></span></div>
    <div class="mapper" id="mapper" ${S.mapperOpen ? "" : "hidden"}>
      <div class="mapgrid">${FIELDS.map(([f, l, req]) => `<label>${l}<span>${req ? "needed" : "optional"}</span><select data-map="${f}"><option value="">None</option>${S.list.columns.map(c => `<option ${m[f] === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select></label>`).join("")}</div>
      <div class="mapopts">
        <span class="inline">Body format <span class="seg" id="fmt">${[["auto", "Detect"], ["text", "Plain text"], ["html", "HTML"]].map(([k, l]) => `<button data-fmt="${k}" class="${(o.format || "auto") === k ? "on" : ""}">${l}</button>`).join("")}</span></span>
        <span class="inline"><span class="toggle"><input type="checkbox" id="opt-unesc" ${o.unescape !== false ? "checked" : ""} aria-label="Treat backslash n as a line break"><span></span></span>Treat <code>\\n</code> in a cell as a line break</span>
        <label class="inline">List name <input type="text" id="opt-name" value="${esc(S.list.name)}" style="width:220px;height:34px"></label>
      </div>
      <p class="ph-note">Any column can go inside the subject or body: write <code>{Column name}</code>. Click one to copy it.</p>
      <div class="chips">${S.list.columns.map(c => `<button class="chip" data-chip="${esc(c)}">{${esc(c)}}</button>`).join("")}</div>
    </div>`;
  $("#mapper-toggle").onclick = () => { S.mapperOpen = !S.mapperOpen; renderStrip(); };
  $("#attach-open").onclick = () => openAttach();
  $("#replace-btn").onclick = () => $("#replace-up").click();
  $("#replace-up").onchange = e => { const f = e.target.files[0]; e.target.value = ""; replaceCSV(f); };
  $$("#strip [data-map]").forEach(s => (s.onchange = () => { if (s.value) m[s.dataset.map] = s.value; else delete m[s.dataset.map]; S.list.mapping = m; saveConfig(); }));
  $$("#strip [data-fmt]").forEach(b => (b.onclick = () => { S.list.opts = { ...o, format: b.dataset.fmt }; saveConfig(); }));
  const ue = $("#opt-unesc"); if (ue) ue.onchange = () => { S.list.opts = { ...o, unescape: ue.checked }; saveConfig(); };
  const nm = $("#opt-name"); if (nm) nm.onchange = async () => { await post(`/api/lists/${S.list.id}/config`, { name: nm.value }); S.list.name = nm.value.trim() || S.list.name; const l = S.lists.find(x => x.id === S.list.id); if (l) l.name = S.list.name; renderHead(); renderShell(); };
  $$("#strip [data-chip]").forEach(b => (b.onclick = async () => { try { await navigator.clipboard.writeText(`{${b.dataset.chip}}`); toast(`Copied {${b.dataset.chip}}`); } catch { toast(`Type {${b.dataset.chip}} in your CSV`); } }));
}
function openAttach(pre) {
  // Pick files from Attachments that go with every email in this list.
  const on = pre || new Set((S.list.opts?.attach || []).map(n => n.toLowerCase()));
  const files = [...new Map(S.files.map(f => [f.name.toLowerCase(), f])).values()];
  const body = `<p>These files go with every email in this list. To attach a file to only some rows, name it in the CSV's Attachments column instead.</p>
    ${files.length ? `<div class="attpick">${files.map(f => `<label class="attrow"><input type="checkbox" class="cb" value="${esc(f.name)}" ${on.has(f.name.toLowerCase()) ? "checked" : ""}><span class="nm">${esc(f.name)}</span><span class="num faint">${size(f.size)}</span></label>`).join("")}</div>`
      : `<p class="faint">No files yet. Upload one, for example your CV.</p>`}
    <label class="btn small"><input type="file" id="attach-up" multiple hidden>Upload a file</label>`;
  const dlg = dialog("Attach to every email", body, "Save", async d => {
    const pick = $$("input.cb:checked", d).map(x => x.value);
    S.list.opts = { ...(S.list.opts || {}), attach: pick };
    await saveConfig();
    toast(pick.length ? `Every email now carries ${pick.join(", ")}` : "No files attached to every email");
  });
  $("#attach-up", dlg.el).onchange = async e => {
    const picked = new Set($$("input.cb:checked", dlg.el).map(x => x.value.toLowerCase()));
    const fd = new FormData(); for (const f of e.target.files) { fd.append("files", f); picked.add(f.name.toLowerCase()); }
    try { const j = await api("/api/files", { method: "POST", body: fd }); S.files = j.files; dlg.close(); openAttach(picked); }
    catch (err) { toast(err.message, "bad"); }
  };
}
async function saveConfig() {
  try {
    await post(`/api/lists/${S.list.id}/config`, { mapping: S.list.mapping, opts: S.list.opts });
    renderStrip(); await runCheck(); defaultSelection(); refreshListParts(); preview(S.cur);
  } catch (e) { toast(e.message, "bad"); }
}
function lastSent(i) {
  const st = S.status[i], b = S.checks[i]?.before;
  if (st?.status === "sent") return esc(when(st.time));
  if (st?.status === "failed") return `Tried ${esc(when(st.time))}`;
  if (st?.status === "unsure") return `Maybe ${esc(when(st.time))}`;
  if (b?.kind === "dup") return `Same as row ${b.row + 1}`;
  if (b) return `${esc(when(b.time).split(",")[0])} · ${b.same_list ? (b.row != null ? `row ${b.row + 1}` : "this list") : esc(b.list_name || "other list")}`;
  return '<span class="faint">Never</span>';
}
const ADDR_FIX = ["No address", "Bad address", "No To column"];
function rawTo(i) { const m = S.list.mapping || {}; return m.to ? (S.list.rows[i] || {})[m.to] || "" : ""; }
function renderTable() {
  const c = counts(true);
  const busyList = jobActive() && S.job.list_id === S.list.id;
  $("#tabs").innerHTML = [["todo", "To send", c.todo], ["fix", "Needs fixing", c.fix], ["before", "Emailed before", c.before], ["sent", "Sent", c.sent], ["all", "All", c.all]]
    .map(([k, l, n]) => `<button role="tab" aria-selected="${S.filter === k}" class="${S.filter === k ? "on" : ""}" data-f="${k}">${l} <span class="num">${n}</span></button>`).join("");
  $$("#tabs [data-f]").forEach(b => (b.onclick = () => { S.filter = b.dataset.f; renderTable(); }));
  const rows = visibleRows();
  $("#tbody").innerHTML = rows.length ? rows.map(i => {
    const ch = S.checks[i] || { to: "", subject: "" }, [label, kind] = rowState(i);
    const fill = S.filter === "fix" && !busyList && ADDR_FIX.includes(label);
    return `<tr data-i="${i}" class="${i === S.cur ? "cur" : ""}"><td class="c"><input type="checkbox" class="cb" data-i="${i}" ${S.selected.has(i) ? "checked" : ""} aria-label="Send row ${i + 1}"></td>
      <td class="n num">${i + 1}</td><td class="to" title="${esc(ch.to)}">${fill ? `<input class="to-in" type="text" inputmode="email" autocomplete="off" spellcheck="false" data-to="${i}" value="${esc(rawTo(i))}" placeholder="Type the address" aria-label="Email address for row ${i + 1}">` : ch.to ? esc(ch.to) : '<span class="none">—</span>'}</td>
      <td class="subj" title="${esc(ch.subject)}">${lastSent(i)}<small>${esc(ch.to) || "No address"}</small></td>
      <td class="st"><span class="pill ${kind}">${label}</span></td></tr>`;
  }).join("") : `<tr class="empty-row"><td colspan="5">${{ before: "Nobody here has been emailed before.", fix: "Nothing needs fixing.", sent: "Nothing from this list has been sent yet.", todo: "Nothing left to send from this list." }[S.filter] || "No rows."}</td></tr>`;
  const all = $("#cb-all"), selVisible = rows.filter(i => S.selected.has(i)).length;
  all.checked = rows.length > 0 && selVisible === rows.length; all.indeterminate = selVisible > 0 && selVisible < rows.length;
  all.onchange = () => { rows.forEach(i => (all.checked ? S.selected.add(i) : S.selected.delete(i))); renderTable(); renderHead(); };
  const n = [...S.selected].filter(sendable).length;
  $("#selinfo").textContent = jobActive() && S.job.list_id === S.list.id ? `${S.job.remaining.length} queued` : `${n} selected`;
  $("#listfoot").innerHTML = S.filter === "fix" && rows.some(i => ADDR_FIX.includes(rowState(i)[0]))
    ? `Type a missing or wrong address straight into the To column and press Enter: it's saved into this list and the next one is ready. Several addresses can go in one row, separated by commas.`
    : `Rows with a problem are never sent. Sent rows stay sent, so pressing Send again only sends the rest.`;
}
/* typing addresses straight into the table (Needs fixing tab) */
const ADDR_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
async function saveTo(t, next) {
  const i = +t.dataset.to, v = t.value.trim();
  if (t.dataset.saving) return;
  if (v === t.defaultValue.trim()) { if (next) focusNextTo(i); return; }
  if (v && !v.split(/[,;\s]+/).filter(Boolean).every(a => ADDR_RE.test(a))) { t.classList.add("bad"); toast("That doesn't look like an email address", "bad"); return; }
  t.dataset.saving = "1"; t.classList.remove("bad");
  try {
    const j = await post(`/api/lists/${S.list.id}/rows/${i}`, { values: { __to__: v } });
    S.list.rows[i] = j.row; S.list.columns = j.columns; S.list.mapping = j.mapping;
    await runCheck();
    if (sendable(i)) S.selected.add(i);
    refreshListParts(); renderStrip();
    if (S.cur === i) preview(i);
    toast(v ? `Row ${i + 1} will go to ${v}` : `Row ${i + 1} has no address now`);
    if (next) focusNextTo(i);
  } catch (e) { delete t.dataset.saving; toast(e.message, "bad"); }
}
function focusNextTo(i) { const ins = $$("#tbody input.to-in"); const nx = ins.find(x => +x.dataset.to > i) || ins[0]; if (nx) { nx.focus(); nx.select(); } }
$("#view").addEventListener("keydown", e => {
  const t = e.target.closest && e.target.closest("input.to-in"); if (!t) return;
  if (e.key === "Enter") { e.preventDefault(); saveTo(t, true); }
  if (e.key === "Escape") { t.value = t.defaultValue; t.classList.remove("bad"); t.blur(); }
});
$("#view").addEventListener("focusout", e => {
  const t = e.target.closest && e.target.closest("input.to-in");
  if (t && t.isConnected && t.value.trim() !== t.defaultValue.trim()) saveTo(t, false);
});
$("#view").addEventListener("click", e => {
  if (e.target.closest("input.to-in")) return;     // typing an address, not opening the row
  const cb = e.target.closest("#tbody input.cb");
  if (cb) { const i = +cb.dataset.i; cb.checked ? S.selected.add(i) : S.selected.delete(i); renderTable(); renderHead(); return; }
  const tr = e.target.closest("#tbody tr[data-i]");
  if (tr) { S.showPv = true; $("#work")?.classList.add("show-pv"); preview(+tr.dataset.i); if (innerWidth <= 900) scrollTo(0, $("#work").offsetTop - 70); }
});
document.addEventListener("keydown", e => {
  if (S.route !== "list" || !S.list || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName) || $(".dlg-back")) return;
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); step(1); }
  if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); step(-1); }
});
function step(d) { const rows = visibleRows(); if (!rows.length) return; const at = rows.indexOf(S.cur); preview(rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + d))]); }

async function preview(i) {
  const pv = $("#pv"); if (!pv || !S.list) return;
  i = Math.max(0, Math.min(S.list.count - 1, i)); S.cur = i;
  $$("#tbody tr.cur").forEach(t => t.classList.remove("cur"));
  const tr = $(`#tbody tr[data-i="${i}"]`); if (tr) { tr.classList.add("cur"); tr.scrollIntoView({ block: "nearest" }); }
  const seq = ++S.pvSeq;
  let p; try { p = await api(`/api/lists/${S.list.id}/preview/${i}`); } catch (e) { pv.innerHTML = `<div class="panel-h"><h2>Row ${i + 1}</h2></div><div class="issues"><div class="issue bad">Couldn't build this email: ${esc(e.message)}</div></div>`; return; }
  if (seq !== S.pvSeq) return;
  S.pvGreeting = p.greeting || ""; showExample();
  const st = S.status[i];
  const busyRow = jobActive() && S.job.list_id === S.list.id && (S.job.remaining.includes(i) || S.job.current === i);
  const canEdit = st?.status !== "sent" && !p.snapshot && !(jobActive() && S.job.list_id === S.list.id);
  const b = p.before;
  const beforeHTML = !b || p.snapshot ? "" : `<div class="before"><b class="h">${b.kind === "dup" ? `Same address as row ${b.row + 1}` : `Already emailed on ${esc(when(b.time))}`}</b>
    <p>${b.kind === "dup" ? `Row ${b.row + 1} also goes to ${esc(b.addr)}. Only the first one is sent, so they don't get it twice.`
      : `${b.same_list ? "From this list" : `From your list <b>${esc(b.list_name || "an earlier list")}</b>`}${b.subject ? `, with the subject "${esc(b.subject)}"` : ""}. ${p.again ? "You chose to send to them again." : "This row is skipped so they don't get it twice."}`}</p>
    <div class="acts">${busyRow ? "" : `<button class="btn small" id="pv-again">${p.again ? "Don't send again" : b.kind === "dup" ? "Send to both anyway" : "Send again anyway"}</button>`}${b.kind === "dup" ? `<a class="link" href="#/list/${S.list.id}/${b.row}">Open row ${b.row + 1}</a>` : b.list_exists && b.row != null ? `<a class="link" href="#/list/${b.list_id}/${b.row}">See what was sent then</a>` : ""}</div></div>`;
  const atts = [...p.attachments.map(a => `<span class="att">${esc(a)}</span>`), ...p.missing_attachments.map(a => `<span class="att miss">${esc(a)} not found</span>`)].join("");
  const head = [["From", p.from || "Connect your account in Account"], ["To", p.to_raw], ["CC", p.cc.join(", ")], ["BCC", p.bcc.join(", ")], ["Reply-to", p.reply_to], ["Subject", p.subject]]
    .filter(([k, v]) => v || k === "To" || k === "Subject").map(([k, v]) => `<dt>${k}</dt><dd>${v ? esc(v) : '<span class="faint">—</span>'}</dd>`).join("");
  const used = (S.list.columns || []).filter(cn => new RegExp("\\{\\{?\\s*" + cn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\}?\\}", "i").test(rawTemplate(i)));
  pv.innerHTML = `<div class="panel-h"><button class="btn small pv-back" id="pv-back">${ICON.prev} Back</button><h2>Row ${i + 1} <span class="faint" style="font-weight:400">of ${S.list.count}</span></h2>
      <div class="right">${canEdit ? '<button class="btn small" id="pv-edit">Edit row</button>' : ""}${st?.status === "sent" ? `<span class="pill sent">Sent ${esc((st.time || "").slice(11, 16))}</span>` : ""}<div class="pv-nav"><button id="pv-prev" aria-label="Previous row">${ICON.prev}</button><button id="pv-next" aria-label="Next row">${ICON.next}</button></div></div></div>
    <dl>${head}<dt>Attached</dt><dd>${atts || '<span class="faint">None</span>'}</dd>${st?.status === "sent" && st.copy ? `<dt>Copy</dt><dd>${st.copy === "saved" ? "Saved in your Sent folder" : '<span class="bad">Not saved in Sent</span>'}</dd>` : ""}<dt>Format</dt><dd>${p.is_html ? "HTML" : "Plain text"}</dd></dl>
    ${ADDR_FIX.includes(rowState(i)[0]) ? `<p class="sent-note">${searchLink(i, p)}</p>` : ""}
    ${p.greeting && canEdit && p.warnings.some(w => /greeting says/.test(w)) ? `<form class="greet-fix" id="greet-fix"><label for="greet-in">Greeting</label><span class="faint">Dear</span><input id="greet-in" type="text" value="${esc(p.greeting)}" autocomplete="off"><button class="btn small" type="submit">Save</button></form>` : ""}
    ${p.snapshot ? `<p class="sent-note">Exactly as sent on ${esc(when(p.time))}.</p>` : ""}${beforeHTML}
    ${p.errors.length || p.warnings.length || st?.status === "failed" || st?.status === "unsure" || st?.copy === "failed" ? `<div class="issues">${st?.copy === "failed" ? `<div class="issue warn">Sent, but the copy wasn't saved in your Sent folder: ${esc(st.copy_error || "unknown error")}</div>` : ""}${p.errors.map(x => `<div class="issue bad">${esc(x)}</div>`).join("")}${st?.status === "failed" && !p.errors.length ? `<div class="issue bad">Last attempt failed: ${esc(st.error)}</div>` : ""}${st?.status === "unsure" ? `<div class="issue warn">${esc(st.error)}</div>` : ""}${p.warnings.map(x => `<div class="issue warn">${esc(x)}</div>`).join("")}</div>` : ""}
    <div class="mail" id="mail"></div>
    ${used.length ? `<div class="filled">Filled in from ${used.map(u => `<b>${esc(u)}</b>`).join(", ")}</div>` : ""}`;
  const box = $("#mail");
  if (p.is_html) {
    const cs = getComputedStyle(document.documentElement);
    const css = `<meta name="color-scheme" content="${document.documentElement.dataset.theme}"><style>html{color-scheme:${document.documentElement.dataset.theme}}html,body{margin:0;background:transparent;color:${cs.getPropertyValue("--mail-ink")};font:15px/1.6 Inter,system-ui,sans-serif;overflow-wrap:anywhere}a{color:inherit}img{max-width:100%}p:first-child{margin-top:0}</style>`;
    const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-same-origin"); f.title = `Email for row ${i + 1}`;
    f.srcdoc = css + p.body; f.onload = () => { try { f.style.height = f.contentDocument.documentElement.scrollHeight + 4 + "px"; } catch {} };
    box.appendChild(f);
  } else box.innerHTML = p.body.trim() ? `<div class="text">${esc(p.body)}</div>` : '<span class="faint">This email has no body.</span>';
  const ag = $("#pv-again"); if (ag) ag.onclick = () => toggleAgain(i, !p.again);
  const ed = $("#pv-edit"); if (ed) ed.onclick = () => editRow(i);
  const gf = $("#greet-fix");
  if (gf) gf.onsubmit = async e => {
    e.preventDefault(); const v = $("#greet-in").value.trim(); if (!v) return;
    try {
      const j = await post(`/api/lists/${S.list.id}/rows/${i}`, { values: { __greeting__: v } });
      S.list.rows[i] = j.row; S.list.columns = j.columns;
      await runCheck(); refreshListParts(); preview(i); toast(`Row ${i + 1} now says “Dear ${v}”`);
    } catch (err) { toast(err.message, "bad"); }
  };
  $("#pv-prev").onclick = () => step(-1); $("#pv-next").onclick = () => step(1);
  $("#pv-back").onclick = () => { S.showPv = false; $("#work").classList.remove("show-pv"); };
}
function rawTemplate(i) {
  const m = S.list.mapping || {}, r = S.list.rows[i] || {}, g = S.list.message || {};
  if (g.mode === "template") return (g.subject || "") + " " + (g.body || "") + " " + (r[m.attachments] || "");
  return (r[m.subject] || "") + " " + (r[m.body] || "") + " " + (r[m.attachments] || "");
}

function searchLink(i, p) {
  // Look the person up: their profile page if the CSV has one, else a web search on the row's short cells.
  const said = p?.no_address_note ? `The list says “${esc(p.no_address_note)}”. ` : "";
  const url = (p?.links || [])[0];
  if (url) return `${said}<a class="link" href="${esc(url)}" target="_blank" rel="noopener">Open their page</a> to find the address, then type it into the To column (Needs fixing tab) or use Edit row.`;
  const m = S.list.mapping || {}, skip = new Set(["to", "subject", "body", "cc", "bcc", "reply_to", "attachments"].map(f => m[f]).filter(Boolean));
  const r = S.list.rows[i] || {};
  const words = S.list.columns.filter(c => !skip.has(c)).map(c => (r[c] || "").trim()).filter(v => v && v.length <= 60 && !/^\d+$/.test(v) && !/@/.test(v));
  if (!words.length) return `Type the address into the To column on the left (Needs fixing tab), or use Edit row.`;
  const q = encodeURIComponent(words.slice(0, 4).join(" ") + " email");
  return `<a class="link" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Search the web for ${esc(words.slice(0, 2).join(", "))}'s email</a>, then type it into the To column (Needs fixing tab) or use Edit row.`;
}
async function toggleAgain(i, on) {
  try {
    const j = await post(`/api/lists/${S.list.id}/again`, { index: i, on }); S.again = new Set(j.again);
    if (on) S.selected.add(i); else S.selected.delete(i);
    refreshListParts(); preview(i);
  } catch (e) { toast(e.message, "bad"); }
}
async function renameList(id, name) {
  name = (name || "").trim(); if (!name) return;
  try { const j = await post(`/api/lists/${id}/config`, { name }); S.lists = j.lists; if (S.list?.id === id) S.list.name = j.name; renderShell(); }
  catch (e) { toast(e.message, "bad"); }
}
function editRow(i) {
  const r = S.list.rows[i] || {}, m = S.list.mapping || {};
  const long = c => c === m.body || /\n/.test(r[c] || "") || (r[c] || "").length > 70;
  const body = `<p>One field per column of your CSV. It's saved into this list; download the corrected CSV from the list's menu.</p>
    <div class="ef">${S.list.columns.map((c, k) => `<label>${esc(c)}${long(c) ? `<textarea rows="5" data-col="${k}">${esc(r[c] || "")}</textarea>` : `<input type="text" data-col="${k}" value="${esc(r[c] || "")}">`}</label>`).join("")}</div>`;
  const dlg = dialog(`Edit row ${i + 1}`, body, "Save row", async d => {
    const values = {}; $$("[data-col]", d).forEach(el => (values[S.list.columns[+el.dataset.col]] = el.value));
    try {
      const j = await post(`/api/lists/${S.list.id}/rows/${i}`, { values }); S.list.rows[i] = j.row;
      if (j.changed.length) { await runCheck(); refreshListParts(); preview(i); toast(`Row ${i + 1} saved`); }
    } catch (e) { toast(e.message, "bad"); }
  }, false, "wide");
  const first = $("[data-col]", dlg.el); if (first) first.focus();
}
async function replaceCSV(file) {
  if (!file || !S.list) return;
  const fd = new FormData(); fd.append("file", file);
  let s; try { s = (await api(`/api/lists/${S.list.id}/replace`, { method: "POST", body: fd })).summary; } catch (e) { toast(e.message, "bad"); return; }
  const row = (dot, label, n) => `<div class="rp-row"><i class="${dot}" aria-hidden="true"></i><span>${label}</span><b class="num">${n.toLocaleString()}</b></div>`;
  dialog(`Replace the CSV for ${esc(S.list.name)}?`,
    `<p>New file <b>${esc(s.file)}</b>, ${plural(s.rows, "row")}. Rows are matched to the old ones by email address.</p>
     <div class="rp">${row("sent", "Already sent, stay sent", s.sent_kept)}${row("ok", "Not sent yet, updated with the new text", s.unsent_updated)}${row("ok", "New, added as ready to send", s.new)}${row("none", "Not in the new file and never sent, removed", s.removed_unsent)}${s.removed_sent ? row("none", "Sent but not in the new file, dropped (still remembered as emailed)", s.removed_sent) : ""}</div>
     ${s.no_to ? `<p class="bad">The app can't tell which column of the new file has the email address. Choose it with Change columns afterwards.</p>` : ""}
     <p>Column choices and "Attached to all" carry over. The old file stays in this list's history.</p>
     ${s.text_changed ? `<p>${plural(s.text_changed, "sent row")} changed since sending. Their preview keeps showing what actually went out.</p>` : ""}`,
    "Replace and keep progress", async () => {
      try { const j = await post(`/api/lists/${S.list.id}/replace/confirm`); S.lists = j.lists; setList(j.list); renderList(); renderShell(); toast(`Replaced with ${s.file}`); }
      catch (e) { toast(e.message, "bad"); }
    }, false, "wide");
}
function closeMenu() { if (S.menuClose) S.menuClose(); }
function listMenu(btn) {
  closeMenu();
  const l = S.lists.find(x => x.id === btn.dataset.more); if (!l) return;
  const m = document.createElement("div"); m.className = "menu"; m.setAttribute("role", "menu"); m.setAttribute("aria-label", `${l.name} actions`);
  m.innerHTML = `<button role="menuitem" data-a="rename">Rename</button><button role="menuitem" data-a="archive">${l.archived ? "Move back to lists" : "Archive"}</button><button role="menuitem" data-a="export">Download with status</button><hr><button role="menuitem" class="danger" data-a="delete">Delete…</button>`;
  document.body.appendChild(m);
  const r = btn.getBoundingClientRect();
  m.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - m.offsetHeight - 8)) + "px";
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8)) + "px";
  btn.setAttribute("aria-expanded", "true");
  const off = e => { if (!m.contains(e.target) && e.target !== btn) closeMenu(); };
  const key = e => { if (e.key === "Escape") { closeMenu(); btn.focus(); } };
  S.menuClose = () => { m.remove(); btn.setAttribute("aria-expanded", "false"); document.removeEventListener("mousedown", off); document.removeEventListener("keydown", key); S.menuClose = null; };
  setTimeout(() => { document.addEventListener("mousedown", off); document.addEventListener("keydown", key); });
  m.querySelector("button").focus();
  m.onclick = async e => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return; closeMenu();
    document.body.classList.remove("menu-open");
    if (a === "rename") { if (S.route === "list" && S.list?.id === l.id) { S.renaming = true; renderHead(); } else { S.renameNext = true; location.hash = `#/list/${l.id}`; } }
    if (a === "archive") {
      try { const j = await post(`/api/lists/${l.id}/config`, { archived: !l.archived }); S.lists = j.lists; renderShell(); toast(l.archived ? `${l.name} is back in your lists` : `${l.name} archived`); }
      catch (err) { toast(err.message, "bad"); }
    }
    if (a === "export") location.href = `/api/lists/${l.id}/export.csv`;
    if (a === "delete") deleteList(l);
  };
}
function deleteList(l) {
  dialog(`Delete ${esc(l.name)}?`, `<p>The list and its history are removed from this app. Everyone already emailed from it is still remembered, so they won't be emailed twice by accident.</p>`, "Delete list", async () => {
    try {
      await api(`/api/lists/${l.id}`, { method: "DELETE" }); S.lists = S.lists.filter(x => x.id !== l.id);
      if (S.list?.id === l.id) { S.list = null; const nx = S.lists.find(x => !x.archived); const h = nx ? `#/list/${nx.id}` : "#/"; if (location.hash !== h) location.hash = h; else route(); }
      renderShell(); toast(`${l.name} deleted`);
    } catch (e) { toast(e.message, "bad"); }
  }, true);
}
async function renderHistory() {
  const v = $("#view");
  if (!S.list) { renderFirstRun(); return; }
  v.innerHTML = `<div class="head"><div><h1>History</h1><p class="sub">${esc(S.list.name)}</p></div></div>`;
  try { const j = await api(`/api/lists/${S.list.id}`); setList(j.list); await runCheck(); } catch (e) { toast(e.message, "bad"); }
  if (S.route !== "history") return;
  const c = counts(), failed = Object.values(S.status).filter(s => s.status === "failed").length;
  const range = (a, z) => { const x = when(a), y = when(z); return x.split(",")[0] === y.split(",")[0] ? `${x}–${y.split(", ")[1] || ""}` : `${x} – ${y}`; };
  const ev = e => {
    let t = esc(when(e.time)), w, x = "";
    if (e.kind === "created") w = `<b>Created</b> <span>from ${esc(e.file)} · ${plural(e.rows || 0, "row")}</span>`;
    else if (e.kind === "renamed") w = `<b>Renamed</b> <span>from "${esc(e.old)}"</span>`;
    else if (e.kind === "send") {
      t = esc(range(e.start || e.time, e.time));
      const bits = [e.failed ? `${e.failed} failed` : "", e.skipped ? `${e.skipped} skipped (emailed before)` : "", e.waits ? `paused ${e.waits} ${e.waits === 1 ? "time" : "times"}` : "", esc(e.outcome || "")].filter(Boolean);
      w = `<b>Sent ${(e.sent || 0).toLocaleString()}</b> <span>${bits.join(" · ")}</span>`;
    } else if (e.kind === "test") w = `<b>Test email</b> <span>of row ${e.row} to ${esc(e.to)}</span>`;
    else if (e.kind === "replaced") {
      w = `<b>CSV replaced</b> <span>with ${esc(e.file)} · ${plural(e.sent_kept || 0, "sent row")} kept${e.new ? ` · ${e.new} new` : ""}${e.removed_unsent ? ` · ${e.removed_unsent} removed` : ""}</span>`;
      if (e.old_file) x = `<a class="link" href="/api/lists/${S.list.id}/file/${encodeURIComponent(e.old_file)}">Old file</a>`;
    } else if (e.kind === "edited") w = `<b>Edited row ${e.row}</b> <span>${esc((e.cols || []).join(", "))}</span>`;
    else if (e.kind === "archived") w = "<b>Archived</b>";
    else if (e.kind === "unarchived") w = "<b>Moved back to lists</b>";
    else w = `<b>${esc(e.kind)}</b>`;
    return `<li><span class="when num">${t}</span><span class="what">${w}</span>${x || "<span></span>"}</li>`;
  };
  const h = [...(S.list.history || [])].reverse();
  v.innerHTML = `<div class="head"><div><h1>History</h1><p class="sub">${esc(S.list.name)} · ${esc(S.list.filename)}</p></div>
    <div class="acts"><a class="btn" href="/api/lists/${S.list.id}/export.csv">Download list with status</a><a class="btn primary" href="#/list/${S.list.id}">Back to the list</a></div></div>
    <section class="panel hist-panel"><div class="hist-kpis">
      <div><b class="num amber">${c.sent.toLocaleString()}</b><span>sent</span></div>
      <div><b class="num">${c.todo.toLocaleString()}</b><span>left to send</span></div>
      <div><b class="num">${c.before.toLocaleString()}</b><span>emailed before, skipped</span></div>
      <div><b class="num">${(failed + c.fix).toLocaleString()}</b><span>failed or need fixing</span></div></div>
      ${h.length ? `<ol class="hist">${h.map(ev).join("")}</ol>` : `<p class="muted">Nothing yet. Sends, renames and file changes show up here.</p>`}
      <p class="hist-foot">Lists made before this update start their history now; their earlier sends are in the Sent log.</p></section>`;
}
async function sendTest() {
  const b = $("#btn-test"); b.disabled = true; const old = b.textContent; b.textContent = "Sending…";
  try { const j = await post(`/api/lists/${S.list.id}/test`, { index: S.cur }); S.allowance = j.allowance; toast(`Test of row ${S.cur + 1} sent to ${j.to}`); refreshListParts(); }
  catch (e) { toast(e.message, "bad"); }
  b.disabled = false; b.textContent = old;
}
function confirmSend() {
  const idx = [...S.selected].filter(sendable).sort((a, b) => a - b);
  const skipped = [...S.selected].length - idx.length;
  const last = simulate(idx.length), now = S.allowance?.now || Date.now() / 1000;
  const long = last - now > 300;
  const att = new Map();
  idx.forEach(i => (S.checks[i]?.attachments || []).forEach(a => att.set(a, (att.get(a) || 0) + 1)));
  const attLine = att.size
    ? `<p>Attached: ${[...att].map(([a, n]) => `<b>${esc(a)}</b>${idx.length < 2 ? "" : n === idx.length ? ` (all ${idx.length})` : ` (${n} of ${idx.length})`}`).join(", ")}.</p>`
    : `<p>No files attached.</p>`;
  const cp = S.copies || {}, bits = [];
  if (cp.save_sent) bits.push("saved in your Sent folder");
  if (cp.bcc_self) bits.push(`BCC'd to <b>${esc(cp.bcc_to || S.account.from_email)}</b>`);
  const copyLine = bits.length ? `<p>A copy of each is ${bits.join(" and ")}.</p>` : `<p>No copies are kept outside this app. Turn them on in Account.</p>`;
  const where = S.mode === "server" ? "The server keeps sending if you close this page or turn your laptop off." : "Keep this app running on your laptop until then.";
  dialog(`Send ${plural(idx.length, "email")}?`,
    `<p>From <b>${esc(S.account.from_email)}</b>, ${S.pace.delay}s apart${S.pace.per_hour ? `, at most ${S.pace.per_hour} an hour` : ""}.</p>
     <p>${long ? `The hourly limit spreads this out: the last one goes out around <b>${clock(last)}</b>, ${inWords(last - now)} from now. ${where}` : `It takes about <b>${inWords(last - now + 1)}</b>.`}</p>
     ${attLine}
     ${copyLine}
     ${counts().before ? `<p>${plural(counts().before, "person", "people")} you've emailed before ${counts().before === 1 ? "is" : "are"} skipped.</p>` : ""}
     ${skipped ? `<p>${plural(skipped, "selected row")} with a problem or already sent will be skipped.</p>` : ""}`,
    `Send ${plural(idx.length, "email")}`, async () => {
      try { const j = await post("/api/send", { list_id: S.list.id, indices: idx }); S.job = j.job; refreshListParts(); poll(true); }
      catch (e) { toast(e.message, "bad"); }
    });
}
function dialog(title, body, okLabel, onOk, danger, cls) {
  const d = document.createElement("div"); d.className = "dlg-back";
  d.innerHTML = `<div class="dlg ${cls || ""}" role="dialog" aria-modal="true" aria-labelledby="dlg-t"><h2 id="dlg-t">${title}</h2>${body}<div class="acts"><button class="btn" data-x>Cancel</button><button class="btn ${danger ? "danger" : "primary"}" data-ok>${okLabel}</button></div></div>`;
  document.body.appendChild(d);
  const close = () => { d.remove(); document.removeEventListener("keydown", key); };
  const key = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", key);
  d.onclick = e => { if (e.target === d || e.target.closest("[data-x]")) close(); };
  d.querySelector("[data-ok]").onclick = () => { close(); onOk(d); };
  d.querySelector("[data-ok]").focus();
  return { el: d, close };
}

function renderFirstRun() {
  $("#view").innerHTML = `
    <div class="head"><div><h1>New list</h1><p class="sub">Load a CSV: one row per email. Each row brings its own address, subject and body.</p></div></div>
    ${S.job ? `<div id="jobslot">${jobHTML()}</div>` : ""}
    <div class="firstrun">
      <div class="fr-left">
      ${S.account?.connected ? "" : `<section class="panel fr-acc"><div><b>${S.account ? "Your mail password is needed" : "First, connect your mail account"}</b><span>${S.account ? `To send as ${esc(S.account.from_email)}.` : "Your IIT Delhi Kerberos ID and password. The app checks the login before saving it."}</span></div><a class="btn primary" href="#/account">Connect</a></section>`}
      <label class="drop" id="drop"><input type="file" id="first-upload" accept=".csv,text/csv,.txt"><b>Choose a CSV file, or drop it here</b><span>Excel: File, Save As, “CSV UTF-8” keeps ₹ and Hindi text intact.</span></label>
      </div>
      <section class="panel"><h2>How the CSV works</h2>
        <ol><li><b>First row</b> is the column names.</li><li>You pick which column is the <b>address</b>, the <b>subject</b> and the <b>body</b>.</li><li>Any other column can go inside them as <code>{Name}</code>, <code>{Roll No}</code>…</li><li>An <b>Attachments</b> column lists file names, several separated by <code>;</code>.</li></ol>
        <div class="sample">For example:<table><thead><tr><th>Email</th><th>Name</th><th>Subject</th><th>Body</th></tr></thead><tbody><tr><td>diya@…</td><td>Diya</td><td>Lab slot for {Name}</td><td>Hi {Name}, your slot is…</td></tr><tr><td>kabir@…</td><td>Kabir</td><td>Lab slot for {Name}</td><td>Hi {Name}, your slot is…</td></tr></tbody></table></div>
      </section>
    </div>`;
  const drop = $("#drop");
  $("#first-upload").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) uploadList(f); };
  ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f) uploadList(f); });
  $$("#jobslot [data-job]").forEach(b => (b.onclick = () => jobAction(b.dataset.job)));
}

/* ---------------------------------------------------------------- sent log */
async function renderLog() {
  const v = $("#view");
  v.innerHTML = `<div class="head"><div><h1>Sent log</h1><p class="sub" id="log-sub">Loading…</p></div><div class="acts"><a class="btn" href="/api/log.csv">Download CSV</a></div></div>
    <div class="log-filter"><div class="seg" id="log-seg"></div></div>
    <section class="panel data-panel"><div class="tablewrap"><table><thead><tr><th>Time</th><th class="hide-s">List</th><th class="r hide-s">Row</th><th class="hide-s">To</th><th>Subject</th><th class="r">Status</th></tr></thead><tbody id="log-body"></tbody></table></div><div class="list-foot" id="log-foot"></div></section>`;
  try { S.logRows = await api("/api/log"); } catch (e) { $("#log-sub").textContent = "Couldn't read the log: " + e.message; return; }
  drawLog();
}
function drawLog() {
  const L = S.logRows, f = S.logFilter;
  $("#log-sub").innerHTML = L.total ? `<b>${L.sent.toLocaleString()} sent</b> · ${L.failed} failed · ${L.tests} tests${L.rows[0] ? ` · last at ${esc(L.rows[0].time.slice(0, 16))}` : ""}` : "Nothing has been sent yet.";
  $("#log-seg").innerHTML = [["all", "All"], ["sent", "Sent"], ["failed", "Failed"], ["test", "Tests"]].map(([k, l]) => `<button class="${f === k ? "on" : ""}" data-lf="${k}">${l}</button>`).join("");
  $$("#log-seg [data-lf]").forEach(b => (b.onclick = () => { S.logFilter = b.dataset.lf; drawLog(); }));
  const rows = L.rows.filter(r => f === "all" || r.status === f || (f === "failed" && r.status === "unsure"));
  const pill = s => s === "sent" ? '<span class="pill sent">Sent</span>' : s === "failed" ? '<span class="pill bad">Failed</span>' : s === "unsure" ? '<span class="pill warn">Check inbox</span>' : '<span class="pill neutral">Test</span>';
  $("#log-body").innerHTML = rows.length ? rows.map(r => `<tr><td class="num">${esc(r.time.slice(0, 16))}</td><td class="hide-s">${esc(r.csv_file)}</td><td class="r num hide-s">${esc(r.row)}</td><td class="hide-s">${esc(r.to) || '<span class="faint">—</span>'}</td>
    <td class="subj">${esc(r.subject) || '<span class="faint">—</span>'}${r.error ? `<div class="err">${esc(r.error)}</div>` : ""}</td><td class="r">${pill(r.status)}</td></tr>`).join("")
    : `<tr class="empty-row"><td colspan="6">${f === "all" ? "Nothing has been sent yet. Sends from every list are recorded here." : "None of these yet."}</td></tr>`;
  $("#log-foot").textContent = L.total > L.rows.length ? `Showing the latest ${L.rows.length} of ${L.total.toLocaleString()}. Download the CSV for all of them.` : `Every send is also written to sent_log.csv next to the app.`;
}

/* ---------------------------------------------------------------- attachments */
function renderFiles() {
  const mine = S.files.filter(f => f.where === "app"), folder = S.files.filter(f => f.where === "folder");
  $("#view").innerHTML = `<div class="head"><div><h1>Attachments</h1><p class="sub">${S.files.length ? `<b>${plural(S.files.length, "file")}</b> your lists can attach.` : "No files yet."} To send a file with every email, open the list and choose <b>Attach files</b>. For only some rows, name it in the list's Attachments column.</p></div>
      <div class="acts"><label class="btn primary"><input type="file" id="files-up" multiple hidden>Add files</label></div></div>
    <section class="panel data-panel"><div class="tablewrap"><table><thead><tr><th>File</th><th class="r">Size</th><th class="hide-s">Kept in</th><th class="r"><span class="sr">Remove</span></th></tr></thead><tbody>
      ${S.files.length ? [...mine, ...folder].map(f => `<tr><td>${esc(f.name)}</td><td class="r num">${size(f.size)}</td><td class="hide-s muted">${f.where === "app" ? "Added here" : "attachments folder"}</td><td class="r">${f.where === "app" ? `<button class="link" data-rm="${esc(f.name)}">Remove</button>` : '<span class="faint">—</span>'}</td></tr>`).join("")
      : `<tr class="empty-row"><td colspan="4">Add the files your CSV names, for example <code>fee-notice.pdf</code>. A row whose file is missing is held back, not sent without it.</td></tr>`}
    </tbody></table></div><div class="list-foot">Files can also be dropped into the <code>attachments</code> folder next to the app, or named by their full path on ${S.mode === "server" ? "the server" : "this computer"}.</div></section>`;
  $("#files-up").onchange = async e => {
    const fd = new FormData(); for (const f of e.target.files) fd.append("files", f); e.target.value = "";
    try { const j = await api("/api/files", { method: "POST", body: fd }); S.files = j.files; S.checks = []; renderFiles(); toast("Files added"); } catch (err) { toast(err.message, "bad"); }
  };
  $$("[data-rm]").forEach(b => (b.onclick = () => dialog(`Remove ${esc(b.dataset.rm)}?`, `<p>Rows that name this file will be held back until it is added again.</p>`, "Remove", async () => {
    const j = await api(`/api/files/${encodeURIComponent(b.dataset.rm)}`, { method: "DELETE" }); S.files = j.files; S.checks = []; renderFiles();
  }, true)));
}

/* ---------------------------------------------------------------- account */
function renderAccount() {
  const a = S.account || {}, saved = store.get("account-draft") || {};
  const prov = a.provider || saved.provider || "iitd";
  const theme = document.documentElement.dataset.theme;
  const where = S.mode === "server" ? "server" : "computer";
  const c = S.copies || {};
  $("#view").innerHTML = `<div class="head"><div><h1>Account</h1><p class="sub">${a.connected ? `Sending as <b>${esc(a.from_email)}</b> through ${esc(a.host)}.` : a.from_email ? `<b>Password needed</b> to send as ${esc(a.from_email)}.` : "Connect the account your emails are sent from."}</p></div></div>
  <div class="settings">
    <div class="sect"><div><h2>Mail account</h2><p class="desc">IIT Delhi: your Kerberos ID (for example ab1234567) and its password, server smtp.iitd.ac.in on port 465. If that port fails, try 587 or 25.</p><p class="desc">Gmail needs an App Password, not your normal one.</p></div>
      <section class="panel"><form id="acc-form" autocomplete="on">
        <div class="seg" id="prov" style="margin-bottom:18px">${[["iitd", "IIT Delhi"], ["gmail", "Gmail"], ["custom", "Other"]].map(([k, l]) => `<button type="button" data-p="${k}" class="${prov === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <div class="fields">
          <label class="f">Username<input type="text" name="username" autocomplete="username" value="${esc(a.username || saved.username || "")}" placeholder="${prov === "gmail" ? "you@gmail.com" : "ab1234567"}"></label>
          <label class="f">Password<input type="password" name="password" autocomplete="current-password" placeholder="${a.connected ? "Saved for this session" : ""}"></label>
          <label class="f">From address<input type="email" name="from_email" value="${esc(a.from_email || saved.from_email || "")}" placeholder="${prov === "gmail" ? "you@gmail.com" : "ab1234567@iitd.ac.in"}"></label>
          <label class="f">Your name, as recipients see it<input type="text" name="from_name" value="${esc(a.from_name || saved.from_name || "")}"></label>
          <label class="f">Reply-to <span class="hint">Optional. Replies go here instead.</span><input type="email" name="reply_to" value="${esc(a.reply_to || saved.reply_to || "")}"></label>
          <div class="row2"><label class="f">Mail server <span class="hint">&nbsp;</span><input type="text" name="host" value="${esc(a.host || saved.host || PROV[prov].host)}"></label><label class="f">Port <span class="hint">&nbsp;</span><input type="number" name="port" value="${esc(a.port || saved.port || PROV[prov].port)}"></label></div>
          <div class="switch-row wide" style="margin-top:4px"><div><div class="t">Remember the password on this ${where}</div><div class="d">Needed to ${S.mode === "server" ? "carry on sending after the server restarts" : "resume a paused send after the app restarts"}. Kept in <code>data/secret.json</code>, readable only by the account running the app.</div></div>
            <span class="toggle"><input type="checkbox" name="remember" ${a.password_saved || (S.mode === "server" && !a.username) ? "checked" : ""} aria-label="Remember the password"><span></span></span></div>
        </div>
        <div class="panel-foot"><button class="btn primary" type="submit">Connect and test</button><span class="msg" id="acc-msg">${a.password_from_env ? "Password comes from the server's settings (MAILER_SMTP_PASSWORD)." : ""}</span></div>
      </form></section></div>

    <div class="sect"><div><h2>Sending pace</h2><p class="desc">IIT Delhi started refusing after about 28 emails in a short time. Under the hourly limit, a long list goes out in batches by itself.</p><p class="desc">If the server still refuses, sending pauses 15, then 30, then 60 minutes and tries again.</p></div>
      <section class="panel"><form id="pace-form"><div class="fields">
        <label class="f">Seconds between emails<input type="number" name="delay" min="0" step="0.5" value="${S.pace.delay}"></label>
        <label class="f">Most emails in any hour <span class="hint">0 means no limit</span><input type="number" name="per_hour" min="0" step="1" value="${S.pace.per_hour}"></label>
        <label class="f wide">Test emails go to<input type="email" name="test_to" value="${esc(S.testTo)}" placeholder="${esc(a.from_email || "you@iitd.ac.in")}"></label>
      </div><div class="estimate" id="estimate"></div>
      <div class="panel-foot"><button class="btn primary" type="submit">Save</button><span class="msg" id="pace-msg"></span></div></form></section></div>

    <div class="sect"><div><h2>Copies of what you send</h2><p class="desc">Emails sent from this app don't show up in your Sent folder by themselves. Turn on one or both.</p><p class="desc">BCC makes you a second recipient of every email, and IIT Delhi may count that toward its limit. The Sent-folder copy adds no recipients.</p></div>
      <section class="panel"><form id="copy-form"><div class="fields">
        ${prov === "gmail" ? `<div class="wide muted">Gmail already keeps a copy of everything sent through it in Sent.</div>` : `
        <div class="switch-row wide"><div><div class="t">Save a copy in my Sent folder</div><div class="d">After each email goes out, the same email, attachments included, is put in Sent on ${esc(c.imap_host || IMAP[prov] || "your IMAP server")}, so you see it in webmail. Nothing is sent twice.</div></div>
          <span class="toggle"><input type="checkbox" name="save_sent" ${c.save_sent ? "checked" : ""} aria-label="Save a copy in my Sent folder"><span></span></span></div>
        <div class="row2"><label class="f">Sent folder server <span class="hint">IMAP</span><input type="text" name="imap_host" value="${esc(c.imap_host || "")}" placeholder="${esc(IMAP[prov] || "imap.example.com")}"></label><label class="f">Port <span class="hint">&nbsp;</span><input type="number" name="imap_port" value="${esc(c.imap_port || 993)}"></label></div>`}
        <div class="switch-row wide"><div><div class="t">BCC me on every email</div><div class="d">A copy of each lands in your inbox. Recipients don't see it. Test emails aren't BCC'd.</div></div>
          <span class="toggle"><input type="checkbox" name="bcc_self" ${c.bcc_self ? "checked" : ""} aria-label="BCC me on every email"><span></span></span></div>
        <label class="f wide">BCC goes to<input type="email" name="bcc_to" value="${esc(c.bcc_to || "")}" placeholder="${esc(a.from_email || "you@iitd.ac.in")}"></label>
      </div><div class="panel-foot"><button class="btn primary" type="submit">Save</button><span class="msg ${c.save_sent && c.sent_folder ? "ok" : ""}" id="copy-msg">${c.save_sent && c.sent_folder ? `Copies go to “${esc(c.sent_folder)}”.` : ""}</span></div></form></section></div>

    <div class="sect"><div><h2>Appearance</h2><p class="desc">Dark is easier on the eyes at night; light shows emails closer to how most inboxes do.</p></div>
      <section class="panel"><div class="seg" id="theme-seg"><button data-t="dark" class="${theme === "dark" ? "on" : ""}">Dark</button><button data-t="light" class="${theme === "light" ? "on" : ""}">Light</button></div></section></div>

    <div class="sect"><div><h2>This app</h2><p class="desc">Where it runs and where it keeps your lists.</p></div>
      <section class="panel"><dl class="kv"><dt>Running on</dt><dd>${S.mode === "server" ? "A server. Sending carries on when your laptop is off." : "This computer. Sending stops if the app is closed."}</dd>
        <dt>Data folder</dt><dd><code>${esc(S.dataDir)}</code></dd><dt>Sign-in</dt><dd>${S.login ? "On. Anyone opening the page needs the app password." : "Off. Only this computer can open the app."}</dd></dl>
        ${S.login ? '<div class="panel-foot"><button class="btn" id="logout">Sign out</button></div>' : ""}</section></div>

    ${a.password_saved && !a.password_from_env ? `<div class="sect"><div><h2>Forget the saved password</h2><p class="desc">Deletes it from this ${where}. Sends that are waiting will need it again.</p></div>
      <section class="panel"><button class="btn danger" id="forget">Forget the password for ${esc(a.username)}</button></section></div>` : ""}
  </div>`;

  let p = prov; const form = $("#acc-form");
  $$("#prov [data-p]").forEach(b => (b.onclick = () => {
    p = b.dataset.p; $$("#prov [data-p]").forEach(x => x.classList.toggle("on", x === b));
    form.host.value = PROV[p].host; form.port.value = PROV[p].port;
    form.username.placeholder = p === "gmail" ? "you@gmail.com" : "ab1234567"; autoFrom();
  }));
  const autoFrom = () => { if (form.from_email.dataset.touched) return; const u = form.username.value.trim(); form.from_email.value = !u ? "" : u.includes("@") ? u : p === "iitd" ? `${u}@iitd.ac.in` : form.from_email.value; };
  form.username.oninput = autoFrom; form.from_email.oninput = () => (form.from_email.dataset.touched = "1");
  form.onsubmit = async e => {
    e.preventDefault(); const m = $("#acc-msg"); m.className = "msg"; m.textContent = `Connecting to ${form.host.value}…`;
    const body = { provider: p, username: form.username.value.trim(), password: form.password.value, from_email: form.from_email.value.trim(), from_name: form.from_name.value.trim(), reply_to: form.reply_to.value.trim(), host: form.host.value.trim(), port: form.port.value, remember: form.remember.checked };
    store.set("account-draft", { ...body, password: undefined, remember: undefined });
    try { const j = await post("/api/account", body); S.account = j.account; form.password.value = ""; m.className = "msg ok"; m.textContent = `Logged in. Sending as ${j.account.from_email}.`; if (!S.testTo) S.testTo = j.account.from_email; renderShell(); if (S.job?.state === "paused") toast("Connected. Press Resume on the list to carry on sending."); }
    catch (err) { m.className = "msg bad"; m.textContent = err.message; }
  };
  const pf = $("#pace-form");
  const est = () => {
    const per = +pf.per_hour.value || 0, d = +pf.delay.value || 0, n = 100;
    let txt;
    if (!per) txt = `100 emails would take about <b>${inWords(n * (d + 1))}</b>, with no hourly limit.`;
    else { const hours = Math.ceil(n / per) - 1, rest = n - hours * per; const secs = hours * 3600 + rest * (d + 1); txt = `100 emails would take about <b>${inWords(secs)}</b>: ${per} an hour, ${d}s apart.`; }
    $("#estimate").innerHTML = txt;
  };
  pf.oninput = est; est();
  pf.onsubmit = async e => {
    e.preventDefault(); const m = $("#pace-msg");
    try { const j = await post("/api/settings", { pace: { delay: pf.delay.value, per_hour: pf.per_hour.value }, test_to: pf.test_to.value }); S.pace = j.pace; S.testTo = j.test_to; m.className = "msg ok"; m.textContent = "Saved."; }
    catch (err) { m.className = "msg bad"; m.textContent = err.message; }
  };
  const cf = $("#copy-form");
  cf.onsubmit = async e => {
    e.preventDefault(); const m = $("#copy-msg"); m.className = "msg";
    const body = { bcc_self: cf.bcc_self.checked, bcc_to: cf.bcc_to.value.trim(), save_sent: cf.save_sent ? cf.save_sent.checked : false,
      imap_host: cf.imap_host ? cf.imap_host.value.trim() : "", imap_port: cf.imap_port ? cf.imap_port.value : 993 };
    m.textContent = body.save_sent ? "Logging in to your Sent folder…" : "Saving…";
    try { const j = await post("/api/settings", { copies: body }); S.copies = j.copies; S.checks = []; m.className = "msg ok"; m.textContent = j.copies.save_sent ? `Saved. Copies go to “${j.copies.sent_folder}”.` : "Saved."; }
    catch (err) { m.className = "msg bad"; m.textContent = err.message; }
  };
  $$("#theme-seg [data-t]").forEach(b => (b.onclick = () => setTheme(b.dataset.t)));
  const lo = $("#logout"); if (lo) lo.onclick = async () => { await post("/logout"); location.href = "/login"; };
  const fg = $("#forget"); if (fg) fg.onclick = () => dialog("Forget the saved password?", `<p>The password for <b>${esc(a.username)}</b> is deleted from this ${where}.</p>`, "Forget it", async () => { const j = await post("/api/account/forget"); S.account = j.account; renderShell(); renderAccount(); toast("Password forgotten"); }, true);
}

/* ---------------------------------------------------------------- polling */
let lastResults = 0;
async function poll(soon) {
  clearTimeout(S.pollT);
  try {
    const j = await api("/api/status");
    const wasActive = jobActive();
    S.job = j.job; S.allowance = j.allowance; S.account = j.account; if (j.lists) S.lists = j.lists;
    if (S.job && S.list && S.job.list_id === S.list.id) for (const r of S.job.results) if (r.status !== "skipped") S.status[r.index] = { status: r.status, time: r.time, error: r.error, copy: r.copy, copy_error: r.copy_error };
    const n = S.job ? S.job.results.length : 0;
    if (S.route === "list") {
      if (n !== lastResults || wasActive !== jobActive()) { if (!jobActive() && wasActive) await runCheck(); if (S.list) { [...S.selected].forEach(i => { if (S.status[i]?.status === "sent") S.selected.delete(i); }); } }
      refreshListParts();
    } else renderShell();
    lastResults = n;
  } catch {}
  S.pollT = setTimeout(poll, jobActive() ? 1000 : 15000);
}

/* ---------------------------------------------------------------- start */
(async function boot() {
  setTheme(document.documentElement.dataset.theme || "dark");
  try {
    const b = await api("/api/bootstrap");
    Object.assign(S, { mode: b.mode, login: b.login, account: b.account, pace: b.pace, testTo: b.test_to, lists: b.lists, files: b.files, copies: b.copies || {}, job: b.job, allowance: b.allowance, dataDir: b.data_dir, templates: b.templates || [] });
    if (b.current) setList(b.current);
    if (!location.hash && b.current) history.replaceState(null, "", `#/list/${b.current.id}`);
  } catch (e) { $("#view").innerHTML = `<div class="head"><div><h1>Can't reach the app</h1><p class="sub">${esc(e.message)} Is app.py still running?</p></div></div>`; return; }
  await route();
  poll();
})();
