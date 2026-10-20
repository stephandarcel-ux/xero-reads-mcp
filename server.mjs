#!/usr/bin/env node
// xero-reads: a READ-ONLY Xero MCP server (stdio, JSON-RPC 2.0, newline-delimited).
//
// Meant to run beside @xeroapi/xero-mcp-server as a second server, adding the reads that one
// lacks. Zero dependencies: Node 18+ only, so there is no npm supply chain to vet.
//
// Read-only by construction, not by promise:
//   - the only HTTP calls are a POST to identity.xero.com for the token and GETs to
//     api.xero.com (see xeroGet); there is no other request function in this file;
//   - give the Xero custom connection only .read scopes, and Xero itself refuses any
//     write even if this code were changed.
//
// Env:
//   XERO_CLIENT_ID, XERO_CLIENT_SECRET  custom connection credentials (required)
//   XERO_SCOPES                         optional; omit to get exactly the scopes granted to
//                                       the connection (avoids invalid_scope if the list drifts)
//   XERO_TENANT_ID                      optional; otherwise read from GET /connections
//   XERO_TEST_ACCESS_TOKEN              local testing only: use this bearer token instead of
//                                       the client-credentials flow (needs XERO_TENANT_ID)

const API = "https://api.xero.com/api.xro/2.0";
const SERVER = { name: "xero-reads", version: "1.0.0" };
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const CONTAINS_SCAN_PAGES = 10; // 10 x 100 invoices, for invoice_number "contains" scans
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── auth ─────────────────────────────────────────────────────────────────────────────
let token = null; // { value, expiresAt }
let tenantId = process.env.XERO_TENANT_ID || null;
let tenantChecked = false;

async function accessToken() {
  if (process.env.XERO_TEST_ACCESS_TOKEN) return process.env.XERO_TEST_ACCESS_TOKEN;
  if (token && Date.now() < token.expiresAt) return token.value;
  const id = process.env.XERO_CLIENT_ID, secret = process.env.XERO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("XERO_CLIENT_ID and XERO_CLIENT_SECRET must be set");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (process.env.XERO_SCOPES) body.set("scope", process.env.XERO_SCOPES);
  const r = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // Never echo the request (it carries the secret); Xero's error code is enough.
    throw new Error(`Xero token request failed (${r.status}): ${j.error || "no access_token"}`);
  }
  token = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in || 1800) - 60) * 1000 };
  return token.value;
}

async function tenantHeader() {
  if (tenantId || tenantChecked) return tenantId ? { "xero-tenant-id": tenantId } : {};
  tenantChecked = true;
  try {
    const r = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" },
    });
    if (r.ok) {
      const list = await r.json();
      if (Array.isArray(list) && list.length) tenantId = list[0].tenantId;
    }
  } catch (_) { /* a custom connection token is bound to one org; the header is optional */ }
  return tenantId ? { "xero-tenant-id": tenantId } : {};
}

// The ONLY data call in this server. GET, always.
async function xeroGet(path, params = {}, { binary = false, accept = "application/json" } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${await accessToken()}`, Accept: accept, ...(await tenantHeader()) },
    });
    if (r.status === 429 && attempt < 2) {
      const wait = Math.min(Number(r.headers.get("retry-after") || 5), 60);
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    if (r.status === 401 && token && attempt < 2) { token = null; continue; }
    if (!r.ok) {
      const text = (await r.text().catch(() => "")).slice(0, 300);
      throw new Error(`Xero GET ${path} failed (${r.status}): ${text}`);
    }
    if (binary) return { bytes: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") };
    return r.json();
  }
  throw new Error(`Xero GET ${path}: still rate-limited after retries`);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────
const need = (v, name) => { if (v === undefined || v === null || v === "") throw new Error(`${name} is required`); return v; };
const guid = (v, name) => { if (!GUID.test(String(v || ""))) throw new Error(`${name} must be a Xero ID (GUID)`); return v; };
const quoted = s => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const ymd = (s, name) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new Error(`${name} must be YYYY-MM-DD`);
  return `DateTime(${+m[1]},${+m[2]},${+m[3]})`;
};

function invoiceSummary(i) {
  return {
    invoice_id: i.InvoiceID, invoice_number: i.InvoiceNumber || null, type: i.Type, status: i.Status,
    contact_id: i.Contact?.ContactID, contact_name: i.Contact?.Name,
    date: i.DateString?.slice(0, 10) || null, due_date: i.DueDateString?.slice(0, 10) || null,
    reference: i.Reference || null, total: i.Total, amount_due: i.AmountDue, amount_paid: i.AmountPaid,
    currency: i.CurrencyCode, has_attachments: !!i.HasAttachments, updated_utc: i.UpdatedDateUTC,
  };
}

function invoiceFull(i) {
  return {
    ...invoiceSummary(i),
    line_amount_types: i.LineAmountTypes, sub_total: i.SubTotal, total_tax: i.TotalTax,
    lines: (i.LineItems || []).map(l => ({
      description: l.Description, quantity: l.Quantity, unit_amount: l.UnitAmount,
      account_code: l.AccountCode, tax_type: l.TaxType, tax_amount: l.TaxAmount, line_amount: l.LineAmount,
      tracking: (l.Tracking || []).map(t => ({ category: t.Name, option: t.Option })),
    })),
    payments: (i.Payments || []).map(p => ({ date: p.Date, amount: p.Amount, reference: p.Reference || null })),
    credit_notes: (i.CreditNotes || []).map(c => ({ number: c.CreditNoteNumber, total: c.Total })),
  };
}

// ── tools ────────────────────────────────────────────────────────────────────────────
const TOOLS = {
  "get-invoice": {
    description: "Get ONE invoice or bill in full (lines with account, tax and tracking as {category, option}, status, type, contact ID, attachments flag, payments). Pass invoice_id, or invoice_number (exact) with optional contact_id to pick between bills that share a number.",
    inputSchema: { type: "object", properties: {
      invoice_id: { type: "string", description: "Xero InvoiceID (GUID)" },
      invoice_number: { type: "string", description: "Exact invoice number" },
      contact_id: { type: "string", description: "Optional ContactID to disambiguate a shared number" },
    } },
    async run(a) {
      let id = a.invoice_id;
      if (id) guid(id, "invoice_id");
      else {
        need(a.invoice_number, "invoice_id or invoice_number");
        const p = { InvoiceNumbers: a.invoice_number, summaryOnly: "true" };
        if (a.contact_id) p.ContactIDs = guid(a.contact_id, "contact_id");
        const found = (await xeroGet("/Invoices", p)).Invoices || [];
        const live = found.filter(i => i.Status !== "DELETED");
        if (!live.length) return { found: 0, note: "No invoice with exactly this number (deleted ones excluded). For a partial number use search-invoices with number_match 'contains'." };
        if (live.length > 1) return { found: live.length, note: "Several invoices share this number. Call again with invoice_id.", matches: live.map(invoiceSummary) };
        id = live[0].InvoiceID;
      }
      const inv = ((await xeroGet(`/Invoices/${id}`)).Invoices || [])[0];
      if (!inv) return { found: 0 };
      return invoiceFull(inv);
    },
  },

  "search-invoices": {
    description: "Search invoices/bills. Filters: type (ACCPAY = bills, ACCREC = sales invoices), statuses, contact_id, date_from/date_to (invoice date, YYYY-MM-DD), invoice_number with number_match 'exact' or 'contains' (contains is case-insensitive and done here, not by Xero, because Xero's own Contains filter misses existing bills). Returns summaries, 100 per page; has_more says whether to ask for the next page. Use get-invoice for lines.",
    inputSchema: { type: "object", properties: {
      type: { type: "string", enum: ["ACCPAY", "ACCREC"] },
      statuses: { type: "array", items: { type: "string", enum: ["DRAFT", "SUBMITTED", "AUTHORISED", "PAID", "VOIDED", "DELETED"] } },
      contact_id: { type: "string" },
      date_from: { type: "string", description: "YYYY-MM-DD" },
      date_to: { type: "string", description: "YYYY-MM-DD" },
      invoice_number: { type: "string" },
      number_match: { type: "string", enum: ["exact", "contains"], default: "exact" },
      page: { type: "integer", minimum: 1, default: 1 },
    } },
    async run(a) {
      const where = [];
      if (a.type) where.push(`Type=="${a.type === "ACCREC" ? "ACCREC" : "ACCPAY"}"`);
      if (a.date_from) where.push(`Date>=${ymd(a.date_from, "date_from")}`);
      if (a.date_to) where.push(`Date<=${ymd(a.date_to, "date_to")}`);
      const base = { summaryOnly: "true", order: "Date DESC" };
      if (where.length) base.where = where.join(" AND ");
      if (a.statuses?.length) base.Statuses = a.statuses.join(",");
      if (a.contact_id) base.ContactIDs = guid(a.contact_id, "contact_id");
      const match = a.number_match || "exact";

      if (a.invoice_number && match === "exact") {
        const rows = (await xeroGet("/Invoices", { ...base, InvoiceNumbers: a.invoice_number })).Invoices || [];
        return { count: rows.length, has_more: false, invoices: rows.map(invoiceSummary) };
      }
      if (a.invoice_number && match === "contains") {
        const needle = String(a.invoice_number).toLowerCase();
        const hits = []; let scanned = 0, p = 1, more = true;
        for (; more && p <= CONTAINS_SCAN_PAGES; p++) {
          const rows = (await xeroGet("/Invoices", { ...base, page: p })).Invoices || [];
          scanned += rows.length; more = rows.length === 100;
          for (const r of rows) if ((r.InvoiceNumber || "").toLowerCase().includes(needle)) hits.push(invoiceSummary(r));
        }
        return { count: hits.length, scanned, truncated: more,
          note: more ? `Scanned the newest ${scanned} matching invoices only. Narrow with contact_id, type or a date range to search the rest.` : undefined,
          invoices: hits };
      }
      const page = Math.max(1, Number(a.page || 1));
      const rows = (await xeroGet("/Invoices", { ...base, page })).Invoices || [];
      return { page, count: rows.length, has_more: rows.length === 100, invoices: rows.map(invoiceSummary) };
    },
  },

  "list-invoice-attachments": {
    description: "List the files attached to an invoice or bill (attachment ID, file name, mime type, size).",
    inputSchema: { type: "object", required: ["invoice_id"], properties: { invoice_id: { type: "string" } } },
    async run(a) {
      const id = guid(a.invoice_id, "invoice_id");
      const rows = (await xeroGet(`/Invoices/${id}/Attachments`)).Attachments || [];
      return { count: rows.length, attachments: rows.map(x => ({
        attachment_id: x.AttachmentID, file_name: x.FileName, mime_type: x.MimeType, size_bytes: x.ContentLength })) };
    },
  },

  "get-invoice-attachment": {
    description: `Download one attachment of an invoice or bill. Returns file name, mime type and the content as base64. Files over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB are refused.`,
    inputSchema: { type: "object", required: ["invoice_id", "attachment_id"], properties: {
      invoice_id: { type: "string" }, attachment_id: { type: "string" } } },
    async run(a) {
      const id = guid(a.invoice_id, "invoice_id"), att = guid(a.attachment_id, "attachment_id");
      const meta = ((await xeroGet(`/Invoices/${id}/Attachments`)).Attachments || []).find(x => x.AttachmentID === att);
      if (!meta) throw new Error("No attachment with that ID on this invoice");
      if (meta.ContentLength > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment is ${meta.ContentLength} bytes, over the ${MAX_ATTACHMENT_BYTES}-byte limit`);
      const { bytes } = await xeroGet(`/Invoices/${id}/Attachments/${att}`, {}, { binary: true, accept: meta.MimeType || "application/octet-stream" });
      return { file_name: meta.FileName, mime_type: meta.MimeType, size_bytes: bytes.length, content_base64: bytes.toString("base64") };
    },
  },

  "get-invoice-history": {
    description: "History and notes of an invoice or bill (who changed what and when, including 'Received through the Xero API from ...' lines that show which app created it).",
    inputSchema: { type: "object", required: ["invoice_id"], properties: { invoice_id: { type: "string" } } },
    async run(a) {
      const id = guid(a.invoice_id, "invoice_id");
      const rows = (await xeroGet(`/Invoices/${id}/History`)).HistoryRecords || [];
      return { count: rows.length, history: rows.map(h => ({ date_utc: h.DateUTCString || h.DateUTC, user: h.User, change: h.Changes, details: h.Details })) };
    },
  },

  "get-contact": {
    description: "One contact: name, status, ABN (TaxNumber), email, phones, addresses, contact people, supplier/customer flags.",
    inputSchema: { type: "object", required: ["contact_id"], properties: { contact_id: { type: "string" } } },
    async run(a) {
      const id = guid(a.contact_id, "contact_id");
      const c = ((await xeroGet(`/Contacts/${id}`)).Contacts || [])[0];
      if (!c) return { found: 0 };
      return {
        contact_id: c.ContactID, name: c.Name, status: c.ContactStatus, tax_number: c.TaxNumber || null,
        email: c.EmailAddress || null, first_name: c.FirstName || null, last_name: c.LastName || null,
        is_supplier: !!c.IsSupplier, is_customer: !!c.IsCustomer,
        phones: (c.Phones || []).filter(p => p.PhoneNumber).map(p => ({ type: p.PhoneType, number: [p.PhoneCountryCode, p.PhoneAreaCode, p.PhoneNumber].filter(Boolean).join(" ") })),
        addresses: (c.Addresses || []).filter(x => x.AddressLine1 || x.City).map(x => ({ type: x.AddressType,
          lines: [x.AddressLine1, x.AddressLine2, x.AddressLine3, x.AddressLine4].filter(Boolean), city: x.City, region: x.Region, postcode: x.PostalCode, country: x.Country })),
        contact_people: (c.ContactPersons || []).map(p => ({ name: [p.FirstName, p.LastName].filter(Boolean).join(" "), email: p.EmailAddress || null })),
        updated_utc: c.UpdatedDateUTC,
      };
    },
  },
};

// ── MCP stdio plumbing ───────────────────────────────────────────────────────────────
const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (...a) => process.stderr.write("[xero-reads] " + a.join(" ") + "\n");

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      return isRequest && send({ jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions: "Read-only Xero tools. Nothing here can create, change or delete anything in Xero.",
      } });
    }
    if (method === "ping") return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") {
      return send({ jsonrpc: "2.0", id, result: { tools: Object.entries(TOOLS).map(([name, t]) => ({
        name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } })) } });
    }
    if (method === "tools/call") {
      const tool = TOOLS[params?.name];
      if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      try {
        const out = await tool.run(params.arguments || {});
        return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
      } catch (e) {
        return send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } });
      }
    }
    if (!isRequest) return; // notifications (e.g. notifications/initialized) need no reply
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    log("handler error:", e.message);
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e.message || e) } });
  }
}

let buf = "";
const inflight = new Set();
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    const p = handle(msg).finally(() => inflight.delete(p));
    inflight.add(p);
  }
});
// Input closed: finish what is in flight, then let Node exit on its own. No process.exit():
// exiting at once dropped pending replies, and exiting before stdout drains cut a 2 MB
// attachment reply in half (both found in live testing).
process.stdin.on("end", async () => { await Promise.allSettled([...inflight]); });
log(`ready (${Object.keys(TOOLS).length} read-only tools)`);
