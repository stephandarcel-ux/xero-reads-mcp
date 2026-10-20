# xero-reads-mcp

A small, read-only [Model Context Protocol](https://modelcontextprotocol.io) server for Xero,
over stdio. It adds the reads that `@xeroapi/xero-mcp-server` lacks: one invoice in full with
tracking, invoice-number "contains" search, attachments, history and full contact details.

- **No write tools.** The only requests are the token POST to `identity.xero.com` and GET
  requests to `api.xero.com`.
- **No dependencies.** One file, Node 18 or newer.
- **Pair it with read-only scopes.** Give the Xero custom connection only `.read` scopes and Xero
  itself refuses any write.

## Run

```
npx -y github:stephandarcel-ux/xero-reads-mcp#<commit>
```

Environment:

| Variable | |
|---|---|
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | Xero custom connection credentials (required) |
| `XERO_SCOPES` | Optional. Leave unset to receive exactly the scopes granted to the connection |
| `XERO_TENANT_ID` | Optional. Otherwise read from `GET /connections` |

Scopes used: `accounting.invoices.read`, `accounting.contacts.read`, `accounting.attachments.read`.

## Tools

| Tool | Xero call |
|---|---|
| `get-invoice` | `GET /Invoices/{id}`, or by exact number. Lines with tracking as `{category, option}` |
| `search-invoices` | `GET /Invoices` filtered by type, statuses, contact, date range and invoice number. 100 per page. "contains" is matched case-insensitively by the server over up to 1,000 invoices, because Xero's own `Contains` filter can miss existing invoices |
| `list-invoice-attachments` | `GET /Invoices/{id}/Attachments` |
| `get-invoice-attachment` | `GET /Invoices/{id}/Attachments/{attachmentId}`, returned as base64, 8 MB cap |
| `get-invoice-history` | `GET /Invoices/{id}/History` |
| `get-contact` | `GET /Contacts/{id}`: tax number, email, phones, addresses, contact people |

## Licence

MIT
