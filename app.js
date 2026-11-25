// Ledger — bill tracker for Team Agnirath. UI layer; all data work happens in engine.js.
{
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtCache = {};
const fmt = (cur = "INR", digits = 2) => (fmtCache[cur + digits] ||= new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US",
  { style: "currency", currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits }));
const money = (n, cur = "INR") => (n == null || n === "" ? "—" : fmt(cur, n % 1 ? 2 : 0).format(n));
const today = () => new Date().toISOString().slice(0, 10);
const monthLabel = (ym, opts = { month: "short", year: "numeric" }) => new Date(ym + "-01T00:00").toLocaleDateString("en-IN", opts);
const dateLabel = (iso) => (iso ? new Date(iso + "T00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
const initials = (s) => (s || "?").replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "₹";

const state = { view: location.hash === "#bills" ? "bills" : "home", filters: { q: "", status: "", category: "" }, categories: [], currencies: [], payers: [] };

const ICON = {
  scan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M12 8v8M8 12h8"/></svg>',
  doc: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  camera: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  upload: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
};
const small = (svg) => svg.replace("<svg", '<svg width="18" height="18"');

const SAMPLES = [
  { file: "samples/higher_energizer_cells.pdf", type: "application/pdf", label: "Higher Energizer", note: "65 Li-ion cells for the battery pack · proforma, IGST" },
  { file: "samples/hayael_carbon_fibre.pdf", type: "application/pdf", label: "Hayael Aerospace", note: "Carbon fibre fabric for the body · CGST + SGST" },
  { file: "samples/sunpower_solar_cells.pdf", type: "application/pdf", label: "SunPower", note: "600 solar cells, imported · billed in USD" },
  { file: "samples/hayael_phone_photo.jpg", type: "image/jpeg", label: "Phone photo of a bill", note: "The Hayael bill, shot on a phone · full OCR" },
];

const api = (path, opts = {}) => Engine.route(path, opts);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}

// GSTIN checksum (mirrors the engine) for live feedback while typing
const CS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function gstinStatus(v) {
  v = (v || "").trim().toUpperCase();
  if (!v) return null;
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return "format";
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = CS.indexOf(v[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return CS[(36 - (sum % 36)) % 36] === v[14] ? "ok" : "checksum";
}

function statusPill(inv) {
  if (inv.reimbursement === "needed") return inv.reimbursed ? `<span class="pill reimbursed">Reimbursed</span>` : `<span class="pill unpaid">To reimburse</span>`;
  return `<span class="pill neutral">No claim</span>`;
}

// ------------------------------------------------------------------ shell
async function render() {
  const me = await api("/api/me");
  Object.assign(state, { categories: me.categories, currencies: me.currencies, payers: me.payers });
  $("#app").innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand"><span class="brand-mark"></span>Ledger <span class="team">Team Agnirath</span></div>
        <button class="avatar" id="menu-btn" aria-label="Menu">⋯</button>
      </header>
      <main id="view"></main>
    </div>
    <nav class="nav">
      <button data-view="home" class="${state.view === "home" ? "active" : ""}">Overview</button>
      <button class="scan-btn" id="nav-scan" aria-label="Add a bill">${ICON.scan}</button>
      <button data-view="bills" class="${state.view === "bills" ? "active" : ""}">Bills</button>
    </nav>`;
  $$(".nav [data-view]").forEach((b) => (b.onclick = () => go(b.dataset.view)));
  $("#nav-scan").onclick = () => openScan();
  $("#menu-btn").onclick = toggleMenu;
  state.view === "home" ? renderHome() : renderBills();
}

function go(view) {
  state.view = view;
  history.replaceState(null, "", view === "home" ? location.pathname : "#" + view);
  render();
}

function toggleMenu(e) {
  e.stopPropagation();
  const existing = $(".menu");
  if (existing) return existing.remove();
  const m = document.createElement("div");
  m.className = "menu";
  m.innerHTML = `<button id="m-export">Export all bills (CSV)</button><button id="m-manual">Add a bill without a file</button><button id="m-reset">Clear all data</button>`;
  $(".shell").appendChild(m);
  $("#m-export").onclick = exportCsv;
  $("#m-manual").onclick = () => { m.remove(); openReview({ manual: true }); };
  $("#m-reset").onclick = async (ev) => {
    ev.stopPropagation();
    const b = ev.target;
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Tap again to erase everything"; return; }
    await Engine.resetAll(); m.remove(); toast("All data cleared"); render();
  };
  setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }));
}

async function exportCsv() {
  const csv = await api("/api/export.csv");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `agnirath-bills-${today()}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("CSV downloaded");
}

// ------------------------------------------------------------------ overview
function introHTML() {
  let hidden = false;
  try { hidden = localStorage.getItem("ledger.intro") === "1"; } catch {}
  if (hidden) return "";
  return `<div class="intro">
    <div><b>Every rupee the team spends, with the bill to prove it.</b> Members buy cells, carbon fibre and parts out of pocket,
    and bills used to get lost in chats and spreadsheets. Upload a bill: Ledger reads the date, amount, GST number and billed-to address,
    you confirm who paid, and reimbursements are tracked until they are settled.</div>
    <div class="intro-actions"><button class="btn primary" id="intro-try">${small(ICON.scan)} Try an example bill</button>
    <button class="link" id="intro-x">Dismiss</button></div></div>`;
}

async function renderHome() {
  const view = $("#view");
  const s = await api("/api/summary");
  const foreign = Object.entries(s.foreign);
  const maxCat = Math.max(...s.by_category.map((c) => c.total), 1);
  const maxMonth = Math.max(...s.by_month.map((m) => m.total), 1);

  view.innerHTML = `
    ${introHTML()}
    <div class="eyebrow">Total spent</div>
    <div class="hero-amount num"><span class="cur">₹</span>${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(s.total)}</div>
    <div class="delta">${s.count} bill${s.count === 1 ? "" : "s"} on record${foreign.length ? ` · plus ${foreign.map(([c, v]) => money(v, c)).join(", ")} in foreign currency` : ""}</div>

    <div class="stats">
      <div class="stat"><div class="label">To reimburse · ${s.pending_count}</div><div class="value num">${money(s.pending_total)}</div></div>
      <div class="stat"><div class="label">Bills</div><div class="value num">${s.count}</div></div>
      <div class="stat"><div class="label">GST paid</div><div class="value num">${money(s.gst_paid)}</div></div>
    </div>

    <h2>Owed to members</h2>
    ${s.owed.length ? `<div class="list">${s.owed.map((o) => `
      <button class="row" data-payer="${esc(o.name)}">
        <div class="glyph">${esc(initials(o.name))}</div>
        <div class="main"><div class="title">${esc(o.name)}</div><div class="sub">${o.count} bill${o.count > 1 ? "s" : ""} waiting${o.foreign ? ` · ${o.foreign} in foreign currency` : ""}</div></div>
        <div class="right"><div class="amount num">${money(o.total)}</div></div>
      </button>`).join("")}</div>`
      : `<div class="muted" style="font-size:14px">Nobody is waiting on a reimbursement.</div>`}

    ${s.by_category.length ? `<h2>Where the money went</h2><div class="cats">${s.by_category.map((c) => `
      <div class="cat-row"><span>${esc(c.category)}</span><span class="num">${money(c.total)}</span>
        <div class="track"><div class="fill" style="width:${(c.total / maxCat) * 100}%"></div></div></div>`).join("")}</div>` : ""}

    ${s.by_month.length > 1 ? `<h2>By month</h2><div class="trend">${s.by_month.map((t) => `
      <div class="col" title="${monthLabel(t.month)} · ${money(t.total)}">
        <div class="bar" style="height:${Math.max(3, (t.total / maxMonth) * 72)}px"></div>
        <div class="m">${monthLabel(t.month, { month: "short" })} ’${t.month.slice(2, 4)}</div></div>`).join("")}</div>` : ""}

    <h2>Recent <button class="link" id="see-all">See all</button></h2>
    ${s.recent.length ? `<div class="list">${s.recent.map(rowHTML).join("")}</div>` : emptyHTML()}`;

  $("#intro-try")?.addEventListener("click", () => openScan());
  $("#intro-x")?.addEventListener("click", () => { try { localStorage.setItem("ledger.intro", "1"); } catch {} $(".intro")?.remove(); });
  $("#see-all").onclick = () => go("bills");
  $$("[data-payer]", view).forEach((b) => (b.onclick = () => { state.filters = { q: b.dataset.payer, status: "pending", category: "" }; go("bills"); }));
  bindRows(view);
  $("#empty-scan")?.addEventListener("click", () => openScan());
}

const emptyHTML = () => `<div class="list"><div class="empty"><strong>No bills yet</strong>Upload a bill, or try one of the team's example bills.<br><br>
  <button class="btn primary" id="empty-scan">${small(ICON.scan)} Add a bill</button></div></div>`;

function rowHTML(inv) {
  return `<button class="row" data-id="${inv.id}">
    <div class="glyph">${esc(initials(inv.vendor_name))}</div>
    <div class="main"><div class="title">${esc(inv.vendor_name || "Untitled bill")}</div>
      <div class="sub">${dateLabel(inv.invoice_date)}${inv.paid_by ? " · Paid by " + esc(inv.paid_by) : ""}</div></div>
    <div class="right"><div class="amount num">${money(inv.total, inv.currency)}</div>${statusPill(inv)}</div>
  </button>`;
}
const bindRows = (root) => $$(".row[data-id]", root).forEach((r) => (r.onclick = () => openBill(+r.dataset.id)));

// ------------------------------------------------------------------ bills list
function renderBills() {
  const f = state.filters;
  $("#view").innerHTML = `
    <input class="search" id="q" placeholder="Search vendor, member, GST number, invoice no." value="${esc(f.q)}">
    <div class="chips" id="status-chips">
      ${[["", "All"], ["pending", "To reimburse"], ["reimbursed", "Reimbursed"], ["none", "No claim"]].map(([v, l]) =>
        `<button class="chip ${f.status === v ? "active" : ""}" data-v="${v}">${l}</button>`).join("")}
      <select class="chip" id="cat-filter" aria-label="Category">
        <option value="">All categories</option>
        ${state.categories.map((c) => `<option ${f.category === c ? "selected" : ""}>${esc(c)}</option>`).join("")}
      </select>
    </div>
    <div id="results"></div>`;
  let t;
  $("#q").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; loadBills(); }, 200); };
  $$("#status-chips [data-v]").forEach((c) => (c.onclick = () => {
    f.status = c.dataset.v;
    $$("#status-chips [data-v]").forEach((x) => x.classList.toggle("active", x === c));
    loadBills();
  }));
  $("#cat-filter").onchange = (e) => { f.category = e.target.value; loadBills(); };
  loadBills();
}

async function loadBills() {
  const f = state.filters;
  const rows = await api(`/api/invoices?${new URLSearchParams({ q: f.q, status: f.status, category: f.category })}`);
  const out = $("#results");
  if (!out) return;
  if (!rows.length) {
    out.innerHTML = f.q || f.status || f.category ? `<div class="empty"><strong>No matches</strong>Try a different search or filter.</div>` : emptyHTML();
    $("#empty-scan")?.addEventListener("click", () => openScan());
    return;
  }
  const groups = {};
  rows.forEach((r) => (groups[(r.invoice_date || "").slice(0, 7)] ||= []).push(r));
  out.innerHTML = Object.entries(groups).map(([ym, list]) => `
    <div class="group-label"><span>${ym ? monthLabel(ym, { month: "long", year: "numeric" }) : "Undated"}</span>
      <span class="num">${list.length} bill${list.length > 1 ? "s" : ""}</span></div>
    <div class="list">${list.map(rowHTML).join("")}</div>`).join("");
  bindRows(out);
}

// ------------------------------------------------------------------ sheets
function openSheet(title, inner) {
  closeSheet(false); // keep blob URLs: the scan preview is reused in the review sheet
  $("#sheet-root").innerHTML = `<div class="overlay"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-head"><h3>${esc(title)}</h3><button class="icon-btn" id="sheet-close" aria-label="Close">×</button></div>
    <div id="sheet-body">${inner}</div></div></div>`;
  $(".overlay").onclick = (e) => { if (e.target === e.currentTarget) closeSheet(); };
  $("#sheet-close").onclick = () => closeSheet();
  document.body.style.overflow = "hidden";
  return $("#sheet-body");
}
function closeSheet(revoke = true) {
  if (revoke) $$("#sheet-root [data-blob]").forEach((i) => URL.revokeObjectURL(i.src || i.href));
  $("#sheet-root").innerHTML = "";
  document.body.style.overflow = "";
}
document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());

// ------------------------------------------------------------------ add a bill
function openScan() {
  const body = openSheet("Add a bill", `
    <div class="drop" id="drop">
      <div class="icon">${ICON.doc}</div>
      <div class="big">Drop a bill here</div>
      <div class="muted" style="font-size:14px">Photo or PDF · Ledger fills in the details for you</div>
      <div class="drop-actions">
        <label class="btn primary">${ICON.camera} Take photo<input type="file" accept="image/*" capture="environment" hidden id="f-cam"></label>
        <label class="btn">${ICON.upload} Choose file<input type="file" accept="image/*,application/pdf" hidden id="f-file"></label>
      </div>
    </div>
    <div class="samples"><div class="eyebrow" style="margin-bottom:10px">Example bills from the team</div>
      <div class="sample-grid">${SAMPLES.map((s, i) => `<button class="sample" data-i="${i}"><b>${s.label}</b><span>${s.note}</span></button>`).join("")}</div></div>
    <div style="text-align:center;margin-top:18px"><button class="link" id="manual">or add a bill without a file</button></div>`);
  const pick = (e) => e.target.files[0] && runScan(e.target.files[0]);
  $("#f-cam", body).onchange = pick;
  $("#f-file", body).onchange = pick;
  $("#manual", body).onclick = () => openReview({ manual: true });
  $$(".sample", body).forEach((b) => (b.onclick = async () => {
    const s = SAMPLES[+b.dataset.i];
    try {
      const blob = await (await fetch(new URL(s.file, location.href))).blob();
      runScan(new File([blob], s.file.split("/").pop(), { type: s.type }));
    } catch { toast("Could not load the example bill"); }
  }));
  const drop = $("#drop", body);
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && runScan(e.dataTransfer.files[0]));
}

const isPdf = (file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
function previewHTML(file, url) {
  return isPdf(file)
    ? `<div class="pdf">${ICON.doc}<div style="margin-top:6px">${esc(file.name || "Bill.pdf")}</div><a href="${url}" target="_blank" rel="noopener" data-blob>Open PDF</a></div>`
    : `<img src="${url}" data-blob alt="Bill preview">`;
}

async function runScan(file) {
  const url = URL.createObjectURL(file);
  const body = $("#sheet-body");
  body.innerHTML = `
    <div class="preview scanning">${previewHTML(file, url)}</div>
    <div class="scan-status"><span class="spinner"></span><span id="scan-msg">Reading the bill…</span><span id="scan-time" class="num"></span></div>`;
  const t0 = performance.now();
  const ticker = setInterval(() => { const el = $("#scan-time"); if (el) el.textContent = ((performance.now() - t0) / 1000).toFixed(1) + "s"; }, 100);
  try {
    const form = new FormData();
    form.append("file", file);
    form.onStage = (msg) => { const el = $("#scan-msg"); if (el) el.textContent = msg; };
    const res = await api("/api/scan", { method: "POST", form });
    res.elapsed = (performance.now() - t0) / 1000;
    openReview({ scan: res, file, url });
  } catch (e) {
    body.innerHTML = `<div class="banner warn">${esc(e.message)}</div><div style="margin-top:14px;display:flex;gap:10px">
      <button class="btn block" id="retry">Try another file</button><button class="btn block" id="manual2">Enter manually</button></div>`;
    $("#retry").onclick = openScan;
    $("#manual2").onclick = () => openReview({ manual: true });
  } finally { clearInterval(ticker); }
}

// ------------------------------------------------------------------ the form
const LOW = 0.75;
const CORE = ["vendor_name", "invoice_date", "total", "vendor_gstin", "billed_to"];

function flagFor(name, value, conf, required) {
  if (conf === undefined) return { cls: "", note: "" };
  const missing = value === null || value === undefined || value === "";
  if (missing && required) return { cls: "low", note: "Not found — please fill" };
  if (!missing && conf < LOW) return { cls: "low", note: "Check this" };
  return { cls: "", note: "" };
}
function label(text, flag) {
  return `<label>${flag.note ? '<span class="check-dot" title="Please check"></span>' : ""}${text}${flag.note ? ` <span class="note">· ${flag.note}</span>` : ""}</label>`;
}
function input({ name, text, type = "text", value, conf, required, placeholder = "", attrs = "" }) {
  const fl = flagFor(name, value, conf, required);
  return `<div class="field ${fl.cls}" data-field="${name}">${label(text, fl)}
    <input name="${name}" id="f-${name}" type="${type}" value="${esc(value ?? "")}" placeholder="${placeholder}" ${attrs}>
    ${name.endsWith("gstin") ? `<div class="hint" data-hint="${name}"></div>` : ""}</div>`;
}

function formHTML(v, c = {}, { detail = false } = {}) {
  const num = 'step="0.01" min="0" inputmode="decimal"';
  const cur = v.currency || "INR";
  const reimb = v.reimbursement || "";
  const payers = [...new Set([...state.payers, "Team account"])];
  const totalFlag = flagFor("total", v.total, c.total, true);
  const anyMore = ["invoice_number", "buyer_gstin", "subtotal", "cgst", "sgst", "igst"].some((k) => c[k] !== undefined && v[k] != null && c[k] < LOW);
  return `<form class="form" id="bill-form" novalidate>
    ${input({ name: "vendor_name", text: "Vendor", value: v.vendor_name, conf: c.vendor_name, required: true, placeholder: "Who sold it?" })}
    <div class="grid2">
      ${input({ name: "invoice_date", text: "Date of invoice", type: "date", value: v.invoice_date || (c.invoice_date === undefined ? today() : ""), conf: c.invoice_date, required: true })}
      <div class="field ${totalFlag.cls}" data-field="total">${label("Amount spent", totalFlag)}
        <div class="money-input"><select name="currency" aria-label="Currency">${state.currencies.map((x) => `<option ${x === cur ? "selected" : ""}>${x}</option>`).join("")}</select>
        <input name="total" id="f-total" type="number" ${num} value="${esc(v.total ?? "")}" placeholder="0.00"></div></div>
    </div>
    <div class="field ${cur === "INR" ? "hidden" : ""}" id="inr-field"><label>Amount in ₹ <span class="note">· optional, so it counts in team totals</span></label>
      <input name="total_inr" type="number" ${num} value="${esc(v.total_inr ?? "")}" placeholder="e.g. after conversion / bank debit"></div>
    ${input({ name: "vendor_gstin", text: "GST number (vendor)", value: v.vendor_gstin, conf: c.vendor_gstin, attrs: 'maxlength="15" autocapitalize="characters" spellcheck="false" class="mono"', placeholder: cur === "INR" ? "15 characters" : "Not applicable for foreign vendors" })}
    ${(() => { const fl = flagFor("billed_to", v.billed_to, c.billed_to, true); return `<div class="field ${fl.cls}" data-field="billed_to">${label("Billed to (name & address on the bill)", fl)}
      <textarea name="billed_to" rows="3" placeholder="e.g. IITM Students Activities Trust, IIT Madras, Chennai 600036">${esc(v.billed_to || "")}</textarea></div>`; })()}

    <div class="divider"></div>
    <div class="field" data-field="paid_by"><label>Paid by</label>
      <input name="paid_by" id="f-paid_by" list="payers" value="${esc(v.paid_by || "")}" placeholder="Member who paid, or Team account" autocomplete="off">
      <datalist id="payers">${payers.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
      <div class="payer-chips">${payers.slice(0, 6).map((p) => `<button type="button" class="chip" data-payer="${esc(p)}">${esc(p)}</button>`).join("")}</div>
    </div>
    <div class="field" data-field="reimbursement"><label>Reimbursement</label>
      <div class="checks">
        <label class="check"><input type="checkbox" name="reimb_needed" ${reimb === "needed" ? "checked" : ""}><span>Reimbursement needed</span></label>
        <label class="check"><input type="checkbox" name="reimb_not" ${reimb === "not_needed" ? "checked" : ""}><span>Not needed</span></label>
      </div>
      ${detail ? `<label class="check done ${reimb === "needed" ? "" : "hidden"}" id="done-row"><input type="checkbox" name="reimbursed" ${v.reimbursed ? "checked" : ""}><span>Reimbursed — money returned to the member</span></label>` : ""}
    </div>

    <details class="more" ${anyMore ? "open" : ""}><summary>More details</summary>
      <div class="form" style="margin-top:12px">
        <div class="grid2">
          ${input({ name: "invoice_number", text: "Invoice no.", value: v.invoice_number, conf: c.invoice_number })}
          <div class="field"><label>Category</label><select name="category">
            ${state.categories.map((x) => `<option ${x === (v.category || "Other") ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></div>
        </div>
        ${input({ name: "buyer_gstin", text: "Team GST number (billed to)", value: v.buyer_gstin, conf: c.buyer_gstin, attrs: 'maxlength="15" autocapitalize="characters" spellcheck="false" class="mono"' })}
        <div class="grid2">
          ${input({ name: "subtotal", text: "Taxable value", type: "number", value: v.subtotal, conf: c.subtotal, attrs: num })}
          ${input({ name: "igst", text: "IGST", type: "number", value: v.igst, conf: c.igst, attrs: num })}
        </div>
        <div class="grid2">
          ${input({ name: "cgst", text: "CGST", type: "number", value: v.cgst, conf: c.cgst, attrs: num })}
          ${input({ name: "sgst", text: "SGST", type: "number", value: v.sgst, conf: c.sgst, attrs: num })}
        </div>
        <div class="reconcile" id="reconcile"></div>
        <div class="field"><label>Notes</label><textarea name="notes" placeholder="What was this for?">${esc(v.notes || "")}</textarea></div>
      </div>
    </details>
  </form>`;
}

function wireForm(root) {
  const form = $("#bill-form", root);
  const needed = form.reimb_needed, notNeeded = form.reimb_not;
  const syncChecks = (changed) => {
    if (changed === needed && needed.checked) notNeeded.checked = false;
    if (changed === notNeeded && notNeeded.checked) needed.checked = false;
    $("#done-row", root)?.classList.toggle("hidden", !needed.checked);
    $('[data-field="reimbursement"]', root).classList.remove("low");
  };
  needed.onchange = () => syncChecks(needed);
  notNeeded.onchange = () => syncChecks(notNeeded);
  $$(".payer-chips [data-payer]", root).forEach((b) => (b.onclick = () => {
    form.paid_by.value = b.dataset.payer;
    $('[data-field="paid_by"]', root).classList.remove("low");
    if (b.dataset.payer === "Team account" && !needed.checked) { notNeeded.checked = true; syncChecks(notNeeded); }
  }));
  form.currency.onchange = () => {
    $("#inr-field", root).classList.toggle("hidden", form.currency.value === "INR");
    update();
  };
  function update() {
    for (const n of ["vendor_gstin", "buyer_gstin"]) {
      const st = gstinStatus(form[n].value);
      const hint = $(`[data-hint="${n}"]`, root);
      const foreign = n === "vendor_gstin" && !form[n].value && form.currency.value !== "INR";
      hint.className = "hint " + (st === "ok" ? "ok" : st ? "bad" : "");
      hint.textContent = st === "ok" ? `✓ Valid GSTIN · ${Engine.STATES[form[n].value.slice(0, 2).toUpperCase()] || ""}`
        : st === "format" ? "Should be 15 characters, e.g. 33AAECH9691R1ZO"
        : st === "checksum" ? "Checksum doesn't match — one character is probably misread"
        : foreign ? "Foreign vendor — no GSTIN on this bill" : "";
    }
    const num = (n) => parseFloat(form[n].value) || 0;
    const tax = num("cgst") + num("sgst") + num("igst");
    const rec = $("#reconcile", root);
    if (num("subtotal") && num("total")) {
      const diff = num("subtotal") + tax - num("total");
      const ok = Math.abs(diff) <= Math.max(1, num("total") * 0.01);
      rec.innerHTML = `<span class="muted">Taxable ${money(num("subtotal"))} + GST ${money(tax)}</span>
        <span style="color:var(${ok ? "--green" : "--amber"})">${ok ? "✓ matches the amount" : `off by ${money(Math.abs(diff))}`}</span>`;
      rec.classList.remove("hidden");
    } else rec.classList.add("hidden");
  }
  form.addEventListener("input", (e) => {
    if (e.target.name?.endsWith("gstin")) e.target.value = e.target.value.toUpperCase();
    e.target.closest(".field")?.classList.remove("low");
    update();
  });
  update();
  return form;
}

function readForm(form) {
  const d = Object.fromEntries(new FormData(form));
  const out = {};
  for (const k of ["vendor_name", "invoice_date", "currency", "total", "total_inr", "vendor_gstin", "billed_to", "paid_by",
    "invoice_number", "buyer_gstin", "subtotal", "cgst", "sgst", "igst", "category", "notes"]) {
    const t = String(d[k] ?? "").trim();
    out[k] = t === "" ? null : ["total", "total_inr", "subtotal", "cgst", "sgst", "igst"].includes(k) ? parseFloat(t) : t;
  }
  out.reimbursement = form.reimb_needed.checked ? "needed" : form.reimb_not.checked ? "not_needed" : null;
  out.reimbursed = !!form.reimbursed?.checked;
  return out;
}

function validate(form, data) {
  const missing = [];
  if (data.total == null) missing.push(["total", "the amount"]);
  if (!data.paid_by) missing.push(["paid_by", "who paid"]);
  if (!data.reimbursement) missing.push(["reimbursement", "whether reimbursement is needed"]);
  missing.forEach(([k]) => $(`[data-field="${k}"]`, form).classList.add("low"));
  if (missing.length) {
    toast("Add " + missing.map((m) => m[1]).join(", "));
    $(`[data-field="${missing[0][0]}"]`, form).scrollIntoView({ behavior: "smooth", block: "center" });
    return false;
  }
  return true;
}

function openReview({ scan, file, url, manual }) {
  const vals = {}, conf = {};
  if (scan) for (const [k, f] of Object.entries(scan.fields)) { vals[k] = f.value; conf[k] = f.confidence; }
  const ocr = scan?.ocr;
  const lowCount = scan ? CORE.filter((k) => scan.fields[k].value != null && scan.fields[k].confidence < LOW).length : 0;
  const source = ocr && (ocr.source === "pdf-text" ? "Read from the PDF" : `Read with OCR (${Math.round(ocr.confidence)}% confidence)`);
  const body = openSheet(manual ? "New bill" : "Check the details", `
    ${scan ? `<div class="preview">${previewHTML(file, url)}</div>
      <div class="banners">
        ${scan.duplicate_of ? `<div class="banner warn">⚠︎ <div>This looks like a bill that's already saved: <b>${esc(scan.duplicate_of.vendor_name || "a bill")}</b>
          · ${esc(scan.duplicate_of.invoice_number || "")} · ${money(scan.duplicate_of.total, scan.duplicate_of.currency)}, paid by ${esc(scan.duplicate_of.paid_by || "—")}.</div></div>` : ""}
        <div class="banner ${lowCount ? "info" : "ok"}"><div>${source} in ${scan.elapsed.toFixed(1)}s. ${lowCount
          ? `<b>${lowCount} field${lowCount > 1 ? "s" : ""}</b> marked <span class="check-dot"></span> need${lowCount > 1 ? "" : "s"} a quick look — then add who paid.`
          : "Everything was found — fix anything that looks off, then add who paid."}</div></div>
      </div>` : ""}
    ${formHTML(vals, scan ? conf : {})}
    ${scan ? `<details class="raw"><summary>Show the text Ledger read</summary><pre>${esc(scan.raw_text)}</pre></details>` : ""}
    <div class="sticky-actions"><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save">Save bill</button></div>`);
  const form = wireForm(body);
  $("#cancel", body).onclick = () => closeSheet();
  $("#save", body).onclick = async (e) => {
    const data = readForm(form);
    if (!validate(body, data)) return;
    e.target.disabled = true;
    try {
      await api("/api/invoices", { method: "POST", body: { ...data, upload_id: scan?.upload_id || null } });
      closeSheet();
      toast(data.reimbursement === "needed" ? `Saved · ${money(data.total, data.currency)} to reimburse to ${data.paid_by}` : "Bill saved");
      render();
    } catch (err) { toast(err.message); e.target.disabled = false; }
  };
}

// ------------------------------------------------------------------ a saved bill
async function openBill(id) {
  const body = openSheet("Bill", `<div class="muted" style="padding:30px 0">Loading…</div>`);
  let inv;
  try { inv = await api(`/api/invoices/${id}`); } catch (e) { body.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; return; }
  $(".sheet-head h3").textContent = inv.vendor_name || "Bill";
  body.innerHTML = `
    ${inv.has_file ? `<div class="preview" id="file-prev"><div class="pdf"><span class="spinner"></span></div></div>` : ""}
    <div class="bill-head">
      <div><div class="hero-amount num" style="font-size:32px">${money(inv.total, inv.currency)}</div>
        <div class="muted" style="font-size:13px">${dateLabel(inv.invoice_date)}${inv.vendor_state ? " · " + esc(inv.vendor_state) : ""}${inv.gst_total ? " · GST " + money(inv.gst_total) : ""}</div></div>
      ${statusPill(inv)}
    </div>
    ${formHTML(inv, {}, { detail: true })}
    ${inv.file?.raw_text ? `<details class="raw"><summary>Text read from the bill · ${inv.file.ocr_source === "pdf-text" ? "PDF" : Math.round(inv.file.ocr_confidence) + "% OCR confidence"}</summary><pre>${esc(inv.file.raw_text)}</pre></details>` : ""}
    <div class="sticky-actions"><button class="btn danger" id="del">Delete</button><button class="btn primary" id="save">Save changes</button></div>`;
  const form = wireForm(body);
  if (inv.has_file) loadFilePreview(inv);
  $("#save", body).onclick = async (e) => {
    const data = readForm(form);
    if (!validate(body, data)) return;
    e.target.disabled = true;
    try { await api(`/api/invoices/${id}`, { method: "PATCH", body: data }); closeSheet(); toast("Saved"); render(); }
    catch (err) { toast(err.message); e.target.disabled = false; }
  };
  $("#del", body).onclick = async (e) => {
    if (e.target.dataset.confirm !== "1") { e.target.dataset.confirm = "1"; e.target.textContent = "Tap again to delete"; return; }
    await api(`/api/invoices/${id}`, { method: "DELETE" });
    closeSheet(); toast("Deleted"); render();
  };
}

async function loadFilePreview(inv) {
  const box = $("#file-prev");
  try {
    const res = await api(`/api/uploads/${inv.upload_id}/file`);
    const url = URL.createObjectURL(await res.blob());
    if (!box.isConnected) return URL.revokeObjectURL(url);
    box.innerHTML = inv.file?.mime === "application/pdf"
      ? `<div class="pdf">${ICON.doc}<div style="margin-top:6px">${esc(inv.file.name || "Bill.pdf")}</div><a href="${url}" target="_blank" rel="noopener" data-blob>Open PDF</a></div>`
      : `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" data-blob alt="Bill"></a>`;
  } catch { box.remove(); }
}

// ------------------------------------------------------------------ boot
render().then(() => setTimeout(() => Engine.getWorker().catch(() => {}), 1500)); // warm up OCR in the background
}
