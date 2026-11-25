// Ledger engine — runs fully in the browser.
//   1. image clean-up on <canvas> (resize, background flattening, Otsu binarisation)
//   2. Tesseract LSTM OCR compiled to WebAssembly (tesseract.js) / pdf.js text layer
//   3. rule-based Indian-invoice parser with per-field confidence + GSTIN checksum repair
//   4. local store (IndexedDB, falls back to memory) behind a tiny REST-style router
"use strict";

const Engine = (() => {
  const BASE = new URL(".", location.href).href;
  const abs = (p) => new URL(p, BASE).href;

  // ================================================================= GSTIN
  const CS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
  const STATES = {
    "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
    "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
    "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
    "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
    "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar",
    "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction",
  };
  const TO_DIGIT = { O: "0", Q: "0", D: "0", I: "1", L: "1", "|": "1", S: "5", B: "8", Z: "2", G: "6", T: "7", A: "4" };
  const TO_ALPHA = { 0: "O", 1: "I", 5: "S", 8: "B", 2: "Z", 6: "G", 4: "A", 7: "T" };
  const PATTERN = "ddaaaaaddddaxzx";
  const CONFUSABLE = ["0ODQ", "1IL7T", "2Z", "5S", "8B", "6G", "4A", "9O0"];
  const LOOKALIKE = new Set(["0O", "0D", "0Q", "OD", "1I", "1L", "IL", "5S", "8B", "2Z", "6G"].flatMap((p) => [p, p[1] + p[0]]));

  function checksumChar(first14) {
    let total = 0;
    for (let i = 0; i < 14; i++) {
      const p = CS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
      total += Math.floor(p / 36) + (p % 36);
    }
    return CS[(36 - (total % 36)) % 36];
  }
  const isValid = (g) => { g = (g || "").toUpperCase(); return GSTIN_RE.test(g) && g.slice(0, 2) in STATES && checksumChar(g.slice(0, 14)) === g[14]; };
  const isDigit = (c) => c >= "0" && c <= "9";
  const isAlpha = (c) => c >= "A" && c <= "Z";

  function coerce(win) {
    let out = "";
    for (let i = 0; i < 15; i++) {
      let ch = win[i];
      const kind = PATTERN[i];
      if (kind === "d") ch = isDigit(ch) ? ch : TO_DIGIT[ch];
      else if (kind === "a") ch = isAlpha(ch) ? ch : TO_ALPHA[ch];
      else if (kind === "z") ch = ch === "Z" || ch === "2" ? "Z" : undefined;
      if (ch === undefined) return null;
      out += ch;
    }
    return GSTIN_RE.test(out) ? out : null;
  }

  function repairs(cand) {
    const out = new Set();
    for (let i = 0; i < cand.length; i++) for (const g of CONFUSABLE) {
      if (!g.includes(cand[i])) continue;
      for (const alt of g) if (alt !== cand[i]) {
        const fixed = coerce(cand.slice(0, i) + alt + cand.slice(i + 1));
        if (fixed && isValid(fixed)) out.add(fixed);
      }
    }
    return out;
  }
  const editCost = (src, out) => [...out].reduce((a, c, i) => a + (c === src[i] ? 0 : LOOKALIKE.has(c + src[i]) ? 0.5 : 1), 0);

  function bestAt(compact, i) {
    const src = compact.slice(i, i + 15);
    const cand = coerce(src);
    if (cand && isValid(cand)) return [cand, "valid"];
    const options = new Map();
    const add = (source, value, extra) => options.set(value, Math.min(options.get(value) ?? 99, extra + editCost(source, value)));
    if (cand) for (const f of repairs(cand)) add(src, f, 0);
    const w16 = compact.slice(i, i + 16);
    if (w16.length === 16) for (let j = 2; j < 16; j++) {
      const s2 = w16.slice(0, j) + w16.slice(j + 1);
      const alt = coerce(s2);
      if (alt) for (const f of isValid(alt) ? [alt] : repairs(alt)) add(s2, f, 1);
    }
    if (options.size) {
      const ranked = [...options].sort((a, b) => a[1] - b[1]);
      if (ranked.length === 1 || ranked[0][1] < ranked[1][1]) return [ranked[0][0], "repaired"];
    }
    if (cand && cand.slice(0, 2) in STATES) return [cand, "invalid"];
    return null;
  }

  function findGstins(text) {
    const found = [], seen = new Set();
    text.split("\n").forEach((line, lineNo) => {
      const compact = line.toUpperCase().replace(/[^A-Z0-9|]/g, "");
      let i = 0;
      while (i <= compact.length - 15) {
        let hit = bestAt(compact, i);
        if (hit && hit[1] !== "valid") {
          // a checksum-valid reading a glyph or two later beats a repaired one here
          for (let k = i + 1; k <= i + 3; k++) { const c = coerce(compact.slice(k, k + 15)); if (c && isValid(c)) { hit = [c, "valid"]; i = k; break; } }
        }
        if (hit) {
          if (!seen.has(hit[0])) { seen.add(hit[0]); found.push({ value: hit[0], status: hit[1], line: lineNo }); }
          i += 15; continue;
        }
        i++;
      }
    });
    return found;
  }

  // ================================================================= parser
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const AMOUNT_RE = /(^|[^\w.,\/-])(?:₹|rs\.?|inr|usd|us\$|\$|eur|€)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)(?![\d%:]|[\/.,-]\d)/gi;
  const CATEGORIES = {
    "Battery & electrical": ["lithium", "li-ion", "battery", "bms", "18650", "21700", "cylindrical cell", "busbar", "contactor", "fuse", "wire", "cable", "connector"],
    "Solar array": ["solar", "photovoltaic", "pv module", "encapsulant", "maxeon", "sunpower", "mppt"],
    "Composites & mechanical": ["carbon fiber", "carbon fibre", "fabric", "gsm", "weave", "epoxy", "resin", "honeycomb", "prepreg", "aluminium", "aluminum", "bolt", "bearing", "machining", "fabrication", "cnc"],
    "Electronics": ["pcb", "microcontroller", "sensor", "resistor", "capacitor", "mosfet", "arduino", "telemetry", "can bus"],
    "Logistics & shipping": ["courier", "freight", "shipping", "customs", "dtdc", "bluedart", "delhivery", "fedex", "dhl", "cargo"],
    "Travel & food": ["irctc", "flight", "uber", "ola", "hotel", "restaurant", "food", "meal", "cab"],
    "Printing & branding": ["print", "flex", "banner", "sticker", "vinyl", "poster", "t-shirt", "jersey"],
    "Software & tools": ["software", "license", "licence", "subscription", "ansys", "solidworks", "cloud", "multimeter", "tools"],
  };
  const CATEGORY_LIST = [...Object.keys(CATEGORIES), "Other"];
  const CURRENCIES = ["INR", "USD", "EUR", "AUD", "GBP"];
  const SKIP_VENDOR = /tax\s*invoice|proforma|commercial\s*invoice|packing\s*list|^invoice|bill\s*of\s*supply|receipt|original|duplicate|triplicate|gstin|gst\s*no|phone|ph[:.]|mob|tel|e-?mail|@|www\.|http|address|date|cin\b|pan\b|abn\b|state\s*code|pin\s*code|cash\s*memo|estimate|quotation|bill\s*no|invoice\s*no|customer|bil+\s*to|ship\s*to|buyer|description|quantity|s\.?\s*no\b|\b\d{6}\b|road|street|nagar|floor|near\b|opp\b/i;
  const COMPANY_HINT = /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|co\.|company|enterprises?|traders?|stores?|mart|industries|solutions|technologies|tech|electronics|aerospace|energizers?|agency|agencies|services|retail|distributors?|suppliers?|works|systems|labs?|pty)\b/i;
  const BUYER_HINT = /bil+(ed)?\s*to|buyer|customer|recipient|ship(ped)?\s*to|consignee|sold\s*to|attn/i;
  // words that belong to the right-hand column of an invoice header, not to an address
  const RIGHT_COL = /\b(purchase\s*order|our\s*ref\w*|payment\s*terms|contact\s*(person|numb?er)|invoice\s*(no|date)|proforma|place\s*of\s*supply|sales\s*person|packing\s*list|commercial\s*invoice|tax\s*invoice|phone\s*\/\s*email|due\s*date|p\.?\s*o\.?\s*#|ship\s*to|dt\s*:)/i;
  const ADDR_STOP = /gstin|gst\s*(no|number|:)|vat|\btin\b|attn|tel(ephone)?|phone|e-?mail|mob(ile)?|s\.?\s*no\b|description|hsn|place\s*of\s*supply|^state\b/i;

  const F = (value, confidence) => ({ value: value ?? null, confidence: Math.round(Math.max(0, Math.min(confidence, 1)) * 100) / 100 });
  const r2 = (n) => Math.round(n * 100) / 100;

  function amountsIn(line) {
    const out = [];
    for (const m of line.matchAll(AMOUNT_RE)) {
      const raw = m[2];
      if (!raw.includes(".") && !raw.includes(",") && raw.length > 7) continue;
      const n = parseFloat(raw.replace(/,/g, ""));
      if (!Number.isNaN(n)) out.push(n);
    }
    return out;
  }

  function mkDate(d, m, y) {
    y = +y; if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, +m - 1, +d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null;
    return y >= 2000 && y <= new Date().getFullYear() + 1 ? dt.toISOString().slice(0, 10) : null;
  }

  function findDates(line, loose = false) {
    const f = [], b = loose ? "" : "\\b";
    for (const m of line.matchAll(/\b(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/g)) f.push(mkDate(m[3], m[2], m[1]));
    for (const m of line.matchAll(new RegExp(b + "(\\d{1,2})[-\\/.](\\d{1,2})[-\\/.](\\d{2,4})\\b", "g"))) f.push(mkDate(m[1], m[2], m[3]) || mkDate(m[2], m[1], m[3]));
    for (const m of line.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-.,\/]*([A-Za-z]{3})[a-z]*[\s\-.,\/']*(\d{2,4})\b/g)) { const mo = MONTHS[m[2].toLowerCase()]; if (mo) f.push(mkDate(m[1], mo, m[3])); }
    for (const m of line.matchAll(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) { const mo = MONTHS[m[1].toLowerCase()]; if (mo) f.push(mkDate(m[2], mo, m[3])); }
    return f.filter(Boolean);
  }

  function extractDate(lines) {
    let best = null;
    lines.forEach((line, i) => {
      const low = line.toLowerCase();
      if (/due|expiry|valid|dob|birth/.test(low)) return;
      const labelled = /date|\bdt\b|dated/.test(low);
      let ds = findDates(line);
      if (!ds.length && labelled) ds = findDates(line, true); // OCR glued a glyph onto the date, e.g. ":11-04" -> "311-04"
      if (!ds.length) return;
      let s = 0.55;
      if (/invoice\s*date|bill\s*date|inv\.?\s*dt|date\s*of\s*(invoice|issue)|invoice\s*no.*\bdt\b/.test(low)) s = 0.95;
      else if (labelled) s = 0.85;
      s -= i * 0.004;
      if (!best || s > best[1]) best = [ds[0], s];
    });
    return best ? F(best[0], best[1]) : F(null, 0);
  }

  const INV_LABEL = /(?:tax\s*)?(?:invoice|inv|bill|receipt|voucher)\s*(?:no|number|num|#|id)\b\.?\s*[:#\-.]?\s*/i;
  function extractInvoiceNo(lines) {
    for (let i = 0; i < lines.length; i++) {
      const m = INV_LABEL.exec(lines[i]);
      if (!m) continue;
      let rest = lines[i].slice(m.index + m[0].length).replace(/^[^A-Za-z0-9]+/, "").trim();
      if (!rest && i + 1 < lines.length) rest = lines[i + 1].trim();
      const toks = rest.split(/\s+/).slice(0, 2).map((t) => (/^([A-Za-z0-9][A-Za-z0-9\/\-_.]{0,30})/.exec(t) || [])[1]).filter(Boolean);
      const tok = toks.find((t) => /\d/.test(t) && !findDates(t).length);
      if (tok) return F(tok.replace(/[.\-\/]+$/, ""), /invoice|bill/i.test(m[0]) ? (tok === toks[0] ? 0.9 : 0.7) : 0.75);
    }
    return F(null, 0);
  }

  const TOTAL_KEYS = [
    [/grand\s*total|total\s*amount\s*(payable|due)|amount\s*payable|net\s*payable|invoice\s*(total|value|amount)|total\s*invoice|balance\s*due|net\s*amount/i, 0.95],
    [/total\s*amount|amount\s*due|total\s*\(?(inr|rs|₹|usd)/i, 0.88],
    [/\btotal\b/i, 0.7],
  ];
  const NOT_TOTAL = /sub\s*-?\s*total|total\s*(tax|gst|qty|quantity|items?|discount|savings|cgst|sgst|igst|in\s*words)|taxable|in\s*words|round/i;
  function amountAfterLabel(lines, i) {
    let v = amountsIn(lines[i]);
    if (!v.length && i + 1 < lines.length) v = amountsIn(lines[i + 1]);
    return v.length ? v[v.length - 1] : null;
  }
  function extractTotal(lines) {
    let best = null;
    lines.forEach((line, i) => {
      if (NOT_TOTAL.test(line.replace(/.*only\b/i, ""))) return;
      for (const [rx, conf] of TOTAL_KEYS) {
        if (!rx.test(line)) continue;
        const v = amountAfterLabel(lines, i);
        if (v && v > 0) {
          const s = conf + i * 0.0005;
          if (!best || s > best[1] || (Math.abs(s - best[1]) < 0.05 && v > best[0])) best = [v, s, i];
        }
        break;
      }
    });
    if (best) return Object.assign(F(best[0], best[1]), { line: best[2] });
    const pool = lines.filter((l) => !/gstin|phone|mob|pin|a\/c|account|ifsc/i.test(l)).flatMap(amountsIn).filter((a) => a > 0 && a < 1e8);
    const dec = pool.filter((a) => a !== Math.trunc(a));
    const use = dec.length ? dec : pool;
    return use.length ? F(Math.max(...use), 0.4) : F(null, 0);
  }
  function extractSubtotal(lines) {
    const rx = /sub\s*-?\s*total|taxable\s*(value|amount|amt)|amount\s*before\s*tax|total\s*before\s*tax/i;
    for (let i = 0; i < lines.length; i++) if (rx.test(lines[i])) { const v = amountAfterLabel(lines, i); if (v) return F(v, 0.85); }
    return F(null, 0);
  }
  function extractTax(lines, kind) {
    const rx = new RegExp(`\\b(?:${kind})\\d*\\b`, "i");
    const vals = [];
    for (const line of lines) {
      if (!rx.test(line) || /gstin|gst\s*no|reg/i.test(line)) continue;
      const nums = amountsIn(line.replace(/@?\s*\d+(\.\d+)?\s*%/g, " "));
      if (nums.length) vals.push([nums[nums.length - 1], line.toLowerCase().includes("total")]);
    }
    if (!vals.length) return F(null, 0);
    const totals = vals.filter((v) => v[1]).map((v) => v[0]);
    if (totals.length) return F(totals[totals.length - 1], 0.85);
    if (vals.length === 1) return F(vals[0][0], 0.8);
    return F(Math.max(...vals.map((v) => v[0])), 0.6);
  }
  function extractCurrency(text, totalLine) {
    const t = totalLine || "";
    const indian = /₹|\brs\.?\s*\d|\binr\b|rupee|gstin|\bcgst|\bsgst|\bigst|\bhsn\b/i.test(text);
    const has = (rx) => rx.test(t) && /\b(usd|eur|aud|gbp)\b/i.test(t) || (!indian && (rx.test(t) || rx.test(text)));
    if (has(/\busd\b|us\s*\$/i)) return F("USD", 0.9);
    if (has(/\beur\b|€/i)) return F("EUR", 0.85);
    if (has(/\baud\b|a\$/i)) return F("AUD", 0.8);
    if (has(/\bgbp\b|£/i)) return F("GBP", 0.8);
    return F("INR", /₹|\brs\.?|\binr\b|rupee/i.test(text) ? 0.95 : 0.7);
  }

  // "Bill To" / "To:" address block -> one line; drops the right-hand header column and Ship-To copies
  function dedupeHalves(s) {
    const w = s.split(" ");
    if (w.length % 2 === 0 && w.length >= 2) {
      const a = w.slice(0, w.length / 2).join(" "), b = w.slice(w.length / 2).join(" ");
      if (a.toLowerCase() === b.toLowerCase()) return a;
    }
    return s;
  }
  function extractBillTo(lines, raw) {
    const LABEL = /^[\s|_:.]*(b[il1|]{1,3}(?:ed)?\s*to|buyer(?:'s)?(?:\s*details)?|consignee|details\s*of\s*(?:buyer|receiver|recipient)|recipient|to)\b\s*[:：\-]?\s*/i;
    for (let i = 0; i < Math.min(lines.length, 40); i++) {
      const m = LABEL.exec(lines[i]);
      if (!m) continue;
      const parts = [];
      let end = i, gotPin = false;
      const take = (raw) => {
        let s = raw;
        const cut = RIGHT_COL.exec(s);
        if (cut) s = s.slice(0, cut.index);
        s = s.split(/\s\|\s|\s{3,}/)[0].replace(/\S+@\S+/g, "").replace(/^[\s|_:.\-]+|[\s|_\-]+$/g, "").trim();
        return dedupeHalves(s);
      };
      const r0 = raw[i], m0 = LABEL.exec(r0);
      const first = take(m0 ? r0.slice(m0.index + m0[0].length) : lines[i].slice(m.index + m[0].length));
      if (first && !ADDR_STOP.test(first) && !LABEL.test(first) && first.replace(/[^A-Za-z0-9]/g, "").length >= 3) parts.push(first);
      for (let j = i + 1; j < Math.min(lines.length, i + 9) && !gotPin; j++) {
        const s = take(raw[j]);
        if (ADDR_STOP.test(s)) break;
        if (LABEL.test(s) && !parts.length) continue;
        if (!s || s.replace(/[^A-Za-z0-9]/g, "").length < 3) { if (parts.length) break; else continue; }
        parts.push(s); end = j;
        if (/\b\d{6}\b/.test(s)) gotPin = true;
      }
      if (!parts.length) continue;
      const value = parts.map((p) => p.replace(/[\s,.]+$/, "")).filter(Boolean).join(", ").replace(/\s{2,}/g, " ");
      return Object.assign(F(value, gotPin ? 0.85 : 0.6), { start: i, end });
    }
    return Object.assign(F(null, 0), { start: -1, end: -1 });
  }

  function cleanName(s) {
    s = s.replace(/^[A-Za-z|]\s+(?=[A-Z]{3})/, "").replace(/\bPVTLTD\b/i, "PVT LTD").replace(/\s{2,}/g, " ").replace(/^[\s:：\-|.,*]+|[\s:：\-|.,*]+$/g, "");
    s = s.split(/\s{2,}|\bgstin\b|\bph\b|\bphone\b/i)[0].trim();
    return s.slice(0, 80);
  }
  function extractVendor(lines, billTo) {
    // 1. explicit label: "Sold by", "Issuer:", "Supplier:"
    for (let i = 0; i < Math.min(lines.length, 25); i++) {
      const m = /^(?:sold\s*by|seller|supplier|issuer|vendor|from)\s*[:：\-]?\s*(.*)$/i.exec(lines[i]);
      if (!m) continue;
      const name = m[1].replace(/[^A-Za-z]/g, "").length >= 3 ? m[1] : lines[i + 1] || "";
      if (name.replace(/[^A-Za-z]/g, "").length >= 3) return F(cleanName(name), 0.9);
    }
    // 2. letterhead at the top (skipping the buyer's address block)
    let best = null;
    lines.slice(0, 14).forEach((line, i) => {
      if (i >= billTo.start && i <= billTo.end) return;
      const letters = line.replace(/[^A-Za-z]/g, "");
      if (letters.length < 3 || SKIP_VENDOR.test(line) || BUYER_HINT.test(line) || RIGHT_COL.test(line)) return;
      if (letters.length / Math.max(line.replace(/ /g, "").length, 1) < 0.6) return;
      let s = 0.55 - i * 0.03;
      if (COMPANY_HINT.test(line)) s += 0.3;
      if (line === line.toUpperCase() && line.length > 4) s += 0.08;
      if (!best || s > best[0]) best = [s, cleanName(line)];
    });
    if (best && best[0] >= 0.75) return F(best[1], best[0]);
    // 3. signature block: "For Higher Energizer"
    for (let i = Math.floor(lines.length * 0.4); i < lines.length; i++) {
      const m = /^for\s+([A-Za-z][A-Za-z0-9&.,'() ]{2,60})$/i.exec(lines[i]);
      if (m && !/\b(any|queries|business|more|details|payment|terms|the|your)\b/i.test(m[1])) return F(cleanName(m[1]), 0.85);
    }
    return best ? F(best[1], best[0]) : F(null, 0);
  }

  function guessCategory(text) {
    const low = text.toLowerCase();
    let best = ["Other", 0];
    for (const [c, kws] of Object.entries(CATEGORIES)) {
      const hits = kws.reduce((a, k) => a + low.split(k).length - 1, 0);
      if (hits > best[1]) best = [c, hits];
    }
    return best[1] ? F(best[0], Math.min(0.4 + 0.15 * best[1], 0.85)) : F("Other", 0.3);
  }

  function parseInvoice(text) {
    const raw = text.split("\n").map((l) => l.trim()).filter(Boolean);       // keeps OCR column gaps
    const lines = raw.map((l) => l.replace(/[ \t]+/g, " "));
    const billTo = extractBillTo(lines, raw);
    const gstins = findGstins(lines.join("\n"));
    let seller = null, buyer = null;
    for (const g of gstins) {
      const inBuyerBlock = billTo.start >= 0 && g.line >= billTo.start && g.line <= billTo.end + 6;
      const ctx = lines.slice(Math.max(0, g.line - 2), g.line + 1).join(" ");
      if ((inBuyerBlock || BUYER_HINT.test(ctx)) && !buyer) buyer = g;
      else if (!seller) seller = g;
      else if (!buyer) buyer = g;
    }
    const gf = (g) => (g ? F(g.value, { valid: 0.95, repaired: 0.8 }[g.status] ?? 0.45) : F(null, 0));

    const total = extractTotal(lines);
    let subtotal = extractSubtotal(lines);
    let cgst = extractTax(lines, "cgst"), sgst = extractTax(lines, "sgst|utgst");
    const igst = extractTax(lines, "igst");
    // intra-state GST is always split equally: recover a half the OCR lost
    if (igst.value == null && (cgst.value == null) !== (sgst.value == null)) {
      if (cgst.value == null) cgst = F(sgst.value, 0.6); else sgst = F(cgst.value, 0.6);
    }
    const taxSum = [cgst, sgst, igst].reduce((a, f) => a + (f.value || 0), 0);
    const tol = (v) => Math.max(1, 0.01 * v);
    if (subtotal.value && taxSum) {
      const expected = r2(subtotal.value + taxSum);
      if (total.value && Math.abs(expected - total.value) <= tol(expected)) {
        for (const f of [total, subtotal, cgst, sgst, igst]) if (f.value != null) f.confidence = Math.max(f.confidence, 0.97);
      } else if (total.value && String(Math.trunc(total.value)).length > 1 &&
                 Math.abs(+String(total.value).slice(1) - expected) <= tol(expected)) {
        total.value = expected; total.confidence = 0.85; // "₹82,305" read as "282,305"
      } else if (!total.value) {
        Object.assign(total, F(expected, 0.55));
      }
    }
    if (subtotal.value == null && total.value && taxSum) subtotal = F(r2(total.value - taxSum), 0.6);
    const currency = extractCurrency(text, total.line != null ? lines[total.line] : "");

    return {
      vendor_name: extractVendor(lines, billTo),
      vendor_gstin: gf(seller), buyer_gstin: gf(buyer),
      billed_to: F(billTo.value, billTo.confidence),
      invoice_number: extractInvoiceNo(lines), invoice_date: extractDate(lines),
      currency, total: F(total.value, total.confidence), subtotal, cgst, sgst, igst,
      category: guessCategory(text),
    };
  }

  // ================================================================= OCR
  let workerPromise = null;
  function getWorker(onProgress) {
    if (!workerPromise) {
      // Language model ships with the page (base64 of eng.traineddata.gz) and is handed to the
      // worker directly, so nothing is fetched from third-party CDNs.
      workerPromise = fetch(abs("vendor/lang/eng.traineddata.gz.b64.txt")).then((r) => {
        if (!r.ok) throw new Error("Could not load OCR language data");
        return r.text();
      }).then((b64) => {
        const bin = atob(b64.trim()), data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        return Tesseract.createWorker([{ code: "eng", data }], 1, {
          workerPath: abs("vendor/worker.min.js"),
          corePath: abs("vendor/core/"),
          workerBlobURL: false,
          cacheMethod: "none",
          logger: (m) => onProgress && onProgress(m),
        });
      }).then(async (w) => { await w.setParameters({ tessedit_pageseg_mode: "4", preserve_interword_spaces: "1" }); return w; })
        .catch((e) => { workerPromise = null; throw e; });
    }
    return workerPromise;
  }

  async function loadBitmap(blob) {
    try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); }
    catch {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);
      return img;
    }
  }

  // grayscale -> flatten lighting (divide by blurred background) -> Otsu threshold
  function preprocess(src) {
    const sw = src.width, sh = src.height;
    const scale = sw < 1600 ? 1600 / sw : sw > 2400 ? 2400 / sw : 1;
    const W = Math.round(sw * scale), H = Math.round(sh * scale);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, W, H);
    const img = ctx.getImageData(0, 0, W, H), d = img.data;
    const gray = new Float32Array(W * H);
    for (let i = 0, p = 0; p < gray.length; i += 4, p++) gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

    // background: downsample by 16, dilate (removes dark text), box blur, bilinear upsample
    const k = 16, bw = Math.ceil(W / k), bh = Math.ceil(H / k);
    let bg = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let s = 0, n = 0;
      for (let yy = y * k; yy < Math.min(H, y * k + k); yy += 2) for (let xx = x * k; xx < Math.min(W, x * k + k); xx += 2) { s += gray[yy * W + xx]; n++; }
      bg[y * bw + x] = s / n;
    }
    const filt = (a, fn, r) => { const o = new Float32Array(a.length); for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const v = []; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const yy = Math.min(bh - 1, Math.max(0, y + dy)), xx = Math.min(bw - 1, Math.max(0, x + dx)); v.push(a[yy * bw + xx]); } o[y * bw + x] = fn(v); } return o; };
    bg = filt(bg, (v) => Math.max(...v), 2);
    bg = filt(bg, (v) => v.reduce((a, b) => a + b, 0) / v.length, 2);
    const hist = new Uint32Array(256);
    const out = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) {
      const fy = Math.min(bh - 1.001, Math.max(0, y / k - 0.5)), y0 = Math.floor(fy), ty = fy - y0;
      for (let x = 0; x < W; x++) {
        const fx = Math.min(bw - 1.001, Math.max(0, x / k - 0.5)), x0 = Math.floor(fx), tx = fx - x0;
        const b = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x0 + 1] * tx) * (1 - ty) + (bg[(y0 + 1) * bw + x0] * (1 - tx) + bg[(y0 + 1) * bw + x0 + 1] * tx) * ty;
        const v = Math.min(255, (gray[y * W + x] / Math.max(b, 1)) * 255);
        out[y * W + x] = v; hist[v | 0]++;
      }
    }
    // Otsu
    const N = W * H;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sB = 0, wB = 0, best = 0, thr = 200;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = N - wB; if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; thr = t; }
    }
    for (let p = 0, i = 0; p < N; p++, i += 4) { const v = out[p] > thr ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // group glyph runs into visual lines; only insert a space where there is a real gap
  function pdfLines(items) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10;
      let row = rows.find((r) => Math.abs(r.y - y) < h * 0.45);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, w: it.width || 0, h, s: it.str });
    }
    return rows.sort((a, b) => b.y - a.y).map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let out = "", end = null;
      for (const it of r.items) {
        if (end !== null && it.x - end > it.h * 0.1) out += " ";
        out += it.s; end = it.x + it.w;
      }
      return out.replace(/\s+/g, " ").trim();
    }).join("\n");
  }

  async function pdfPages(blob, onStage) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = abs("vendor/pdf.worker.min.js");
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false }).promise;
    const n = Math.min(pdf.numPages, 3);
    let text = "";
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      text += pdfLines((await page.getTextContent()).items) + "\n";
    }
    if (text.trim().length > 40) return { text, canvases: [] };
    onStage && onStage("Scanned PDF — rendering pages…");
    const canvases = [];
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 300 / 72 });
      const c = document.createElement("canvas");
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      canvases.push(c);
    }
    return { text: null, canvases };
  }

  async function extractText(blob, onStage = () => {}) {
    const isPdf = blob.type === "application/pdf" || new Uint8Array(await blob.slice(0, 4).arrayBuffer()).join() === "37,80,68,70";
    let sources;
    if (isPdf) {
      onStage("Reading PDF…");
      const r = await pdfPages(blob, onStage);
      if (r.text) return { text: r.text, confidence: 99, source: "pdf-text", pages: 1 };
      sources = r.canvases;
    } else sources = [await loadBitmap(blob)];

    onStage("Loading OCR engine…");
    const worker = await getWorker();
    const texts = [], confs = [];
    for (const s of sources) {
      onStage("Cleaning up the image…");
      await new Promise((r) => setTimeout(r, 30));
      const clean = preprocess(s);
      onStage("Recognising text…");
      const { data } = await worker.recognize(clean);
      texts.push(data.text); confs.push(data.confidence);
    }
    return { text: texts.join("\n"), confidence: Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 10) / 10, source: "ocr", pages: sources.length };
  }

  // ================================================================= store
  const Store = (() => {
    const mem = { invoices: new Map(), uploads: new Map(), meta: new Map() };
    let dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((res) => {
        try {
          const req = indexedDB.open("ledger-demo", 1);
          req.onupgradeneeded = () => { for (const s of ["invoices", "uploads", "meta"]) req.result.createObjectStore(s); };
          req.onsuccess = () => res(req.result);
          req.onerror = () => res(null);
        } catch { res(null); }
      });
      return dbp;
    }
    async function tx(store, mode, fn) {
      const db = await open();
      if (!db) return fn(null, mem[store]);
      return new Promise((res, rej) => {
        try {
          const t = db.transaction(store, mode), s = t.objectStore(store);
          const r = fn(s, null);
          t.oncomplete = () => res(r ? r.result : undefined);
          t.onerror = () => rej(t.error);
        } catch (e) { res(fn(null, mem[store])); }
      });
    }
    return {
      get: (st, k) => tx(st, "readonly", (s, m) => (s ? s.get(k) : m.get(k))),
      put: (st, k, v) => tx(st, "readwrite", (s, m) => (s ? s.put(v, k) : m.set(k, v))),
      del: (st, k) => tx(st, "readwrite", (s, m) => (s ? s.delete(k) : m.delete(k))),
      all: (st) => tx(st, "readonly", (s, m) => (s ? s.getAll() : [...m.values()])),
      clear: (st) => tx(st, "readwrite", (s, m) => (s ? s.clear() : m.clear())),
    };
  })();

  // ================================================================= local "API"
  const FIELDS = ["vendor_name", "invoice_date", "currency", "total", "total_inr", "vendor_gstin", "billed_to", "paid_by",
    "reimbursement", "reimbursed", "invoice_number", "buyer_gstin", "subtotal", "cgst", "sgst", "igst", "category", "notes"];
  const NUMERIC = ["total", "total_inr", "subtotal", "cgst", "sgst", "igst"];
  const today = () => new Date().toISOString().slice(0, 10);
  const err = (msg) => { const e = new Error(msg); e.api = true; return e; };
  const inrOf = (i) => (i.currency === "INR" || !i.currency ? i.total : i.total_inr || 0);
  const pending = (i) => i.reimbursement === "needed" && !i.reimbursed;

  function serialize(inv) {
    const g = inv.vendor_gstin;
    return { ...inv, has_file: !!inv.upload_id, gst_total: r2((inv.cgst || 0) + (inv.sgst || 0) + (inv.igst || 0)),
      vendor_gstin_valid: g ? isValid(g) : null, vendor_state: g ? STATES[g.slice(0, 2)] || null : null };
  }
  function clean(body, partial) {
    const out = {};
    for (const f of FIELDS) {
      if (partial && !(f in body)) continue;
      let v = body[f];
      if (v === "" || v === undefined) v = null;
      if (NUMERIC.includes(f) && v != null) {
        v = Number(v);
        if (!Number.isFinite(v) || v < 0) throw err(`${f.replace("_", " ")} must be a positive number`);
      }
      if ((f === "vendor_gstin" || f === "buyer_gstin") && v) {
        v = String(v).trim().toUpperCase();
        if (!GSTIN_RE.test(v)) throw err("GST number must be 15 characters, e.g. 33AAECH9691R1ZO");
      }
      if (f === "category" && v && !CATEGORY_LIST.includes(v)) v = "Other";
      if (f === "currency" && v && !CURRENCIES.includes(v)) v = "INR";
      if (f === "reimbursement" && v && !["needed", "not_needed"].includes(v)) v = "not_needed";
      if (f === "reimbursed") v = v === true || v === "true" || v === "on";
      if (typeof v === "string") v = v.trim().slice(0, 600);
      out[f] = v;
    }
    return out;
  }
  async function allInvoices() { return (await Store.all("invoices")) || []; }
  async function nextId() { const n = ((await Store.get("meta", "seq")) || 0) + 1; await Store.put("meta", "seq", n); return n; }
  async function findDuplicate(number, gstin, total) {
    if (!number) return null;
    return (await allInvoices()).find((i) => (i.invoice_number || "").toLowerCase() === number.toLowerCase() &&
      (gstin ? i.vendor_gstin === gstin : i.total === total)) || null;
  }

  async function createInvoice(body, uploadId) {
    const data = clean(body, false);
    if (data.total == null) throw err("Amount is required");
    if (!data.paid_by) throw err("Add who paid for this");
    const now = new Date().toISOString();
    const inv = { ...data, id: await nextId(), upload_id: uploadId || null, created_at: now, updated_at: now };
    inv.invoice_date = inv.invoice_date || today();
    inv.currency = inv.currency || "INR";
    inv.category = inv.category || "Other";
    inv.reimbursement = inv.reimbursement || "not_needed";
    await Store.put("invoices", inv.id, inv);
    return inv;
  }

  async function route(path, { method = "GET", body, form } = {}) {
    const url = new URL(path, "http://x");
    const p = url.pathname, q = url.searchParams;
    let m;
    if (p === "/api/me") {
      const payers = [...new Set((await allInvoices()).map((i) => i.paid_by).filter(Boolean))];
      return { categories: CATEGORY_LIST, currencies: CURRENCIES, payers };
    }

    if (p === "/api/scan" && method === "POST") {
      const file = form.get("file");
      if (!file) throw err("No file");
      if (file.size > 15 * 1024 * 1024) throw err("File is larger than 15 MB");
      if (!/^image\/|application\/pdf/.test(file.type) && !/\.(pdf|png|jpe?g|webp|bmp)$/i.test(file.name || "")) throw err("Upload a JPG, PNG, WEBP or PDF bill");
      const ocr = await extractText(file, form.onStage);
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
      await Store.put("uploads", id, { id, blob: file, mime: file.type || "application/octet-stream", filename: file.name, ocr_text: ocr.text, ocr_confidence: ocr.confidence, ocr_source: ocr.source });
      const fields = parseInvoice(ocr.text);
      const dup = await findDuplicate(fields.invoice_number.value, fields.vendor_gstin.value, fields.total.value);
      return { upload_id: id, fields, ocr: { confidence: ocr.confidence, source: ocr.source, pages: ocr.pages }, raw_text: ocr.text, duplicate_of: dup ? serialize(dup) : null };
    }

    if (p === "/api/invoices" && method === "POST") return serialize(await createInvoice(body, body.upload_id));

    if (p === "/api/invoices") {
      const term = (q.get("q") || "").toLowerCase(), st = q.get("status"), cat = q.get("category");
      return (await allInvoices())
        .filter((i) => !term || [i.vendor_name, i.invoice_number, i.notes, i.vendor_gstin, i.paid_by, i.billed_to].some((v) => (v || "").toLowerCase().includes(term)))
        .filter((i) => !st || (st === "pending" ? pending(i) : st === "reimbursed" ? i.reimbursement === "needed" && i.reimbursed : i.reimbursement !== "needed"))
        .filter((i) => !cat || i.category === cat)
        .sort((a, b) => (b.invoice_date || "").localeCompare(a.invoice_date || "") || b.id - a.id).map(serialize);
    }

    if ((m = p.match(/^\/api\/invoices\/(\d+)$/))) {
      const inv = await Store.get("invoices", +m[1]);
      if (!inv) throw err("Bill not found");
      if (method === "GET") {
        const out = serialize(inv);
        const up = inv.upload_id && (await Store.get("uploads", inv.upload_id));
        if (up) out.file = { mime: up.mime, name: up.filename, ocr_confidence: up.ocr_confidence, ocr_source: up.ocr_source, raw_text: up.ocr_text };
        return out;
      }
      if (method === "PATCH") {
        const upd = { ...inv, ...clean(body, true), updated_at: new Date().toISOString() };
        if (upd.total == null) throw err("Amount is required");
        if (upd.reimbursement !== "needed") upd.reimbursed = false;
        await Store.put("invoices", inv.id, upd);
        return serialize(upd);
      }
      if (method === "DELETE") {
        await Store.del("invoices", inv.id);
        if (inv.upload_id) await Store.del("uploads", inv.upload_id);
        return { ok: true };
      }
    }

    if ((m = p.match(/^\/api\/uploads\/([^/]+)\/file$/))) {
      const up = await Store.get("uploads", decodeURIComponent(m[1]));
      if (!up) throw err("File not found");
      return new Response(up.blob, { headers: { "Content-Type": up.mime } });
    }

    if (p === "/api/summary") {
      const all = await allInvoices();
      const foreign = {};
      all.filter((i) => i.currency && i.currency !== "INR" && !i.total_inr).forEach((i) => (foreign[i.currency] = r2((foreign[i.currency] || 0) + i.total)));
      const owed = {};
      all.filter(pending).forEach((i) => { const k = i.paid_by || "Unknown"; owed[k] = owed[k] || { name: k, total: 0, count: 0, foreign: 0 }; owed[k].total += inrOf(i); owed[k].count++; if (i.currency !== "INR" && !i.total_inr) owed[k].foreign++; });
      const byCat = {};
      all.forEach((i) => (byCat[i.category || "Other"] = (byCat[i.category || "Other"] || 0) + inrOf(i)));
      const byMonth = {};
      all.forEach((i) => { const k = (i.invoice_date || "").slice(0, 7); if (k) byMonth[k] = (byMonth[k] || 0) + inrOf(i); });
      const months = Object.keys(byMonth).sort().slice(-8);
      return {
        total: r2(all.reduce((a, i) => a + inrOf(i), 0)), foreign, count: all.length,
        gst_paid: r2(all.filter((i) => (i.currency || "INR") === "INR").reduce((a, i) => a + (i.cgst || 0) + (i.sgst || 0) + (i.igst || 0), 0)),
        pending_total: r2(all.filter(pending).reduce((a, i) => a + inrOf(i), 0)), pending_count: all.filter(pending).length,
        owed: Object.values(owed).map((o) => ({ ...o, total: r2(o.total) })).sort((a, b) => b.total - a.total),
        by_category: Object.entries(byCat).filter(([, t]) => t > 0).map(([category, total]) => ({ category, total: r2(total) })).sort((a, b) => b.total - a.total),
        by_month: months.map((k) => ({ month: k, total: r2(byMonth[k]) })),
        recent: [...all].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")).slice(0, 5).map(serialize),
      };
    }

    if (p === "/api/export.csv") {
      const rows = (await allInvoices()).sort((a, b) => (a.invoice_date || "").localeCompare(b.invoice_date || ""));
      const esc = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      return [["id", ...FIELDS].join(","), ...rows.map((r) => [r.id, ...FIELDS.map((f) => r[f])].map(esc).join(","))].join("\n");
    }
    throw err("Not found");
  }

  async function resetAll() { for (const s of ["invoices", "uploads", "meta"]) await Store.clear(s); }

  return { route, parseInvoice, extractText, isValid, findGstins, amountsIn, resetAll, getWorker, CATEGORY_LIST, CURRENCIES, STATES };
})();
