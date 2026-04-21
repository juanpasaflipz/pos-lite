# CSD (Certificado de Sello Digital) Security Policy

**Owner:** Juan (juan@injupe.com)
**Version:** 1.0 — 2026-04-21
**Scope:** pos-lite (`github.com/juanpasaflipz/pos-lite`, `pos.desktop.kitchen`)
**Classification:** Internal — share with design partner on request.

---

## What is a CSD and why this document exists

A **CSD** is a Mexican SAT-issued digital seal certificate (`.cer` + `.key` +
password) that a taxpayer uses to sign CFDI invoices. A compromised CSD can
issue **fraudulent CFDIs under the taxpayer's RFC** — the SAT treats those
invoices as legally binding. The blast radius of a CSD leak is civil and tax
liability for the restaurant, not just a service outage. This policy exists
because pos-lite handles CSD uploads on behalf of tenants and we need to be
able to show a contador or auditor, on one page, how we handle it.

---

## Core principle — **pos-lite never stores CSD material at rest**

CSD upload is delegated to [FacturAPI](https://facturapi.io). pos-lite acts as
a proxy: the `.cer`, `.key`, and password arrive in an HTTP request, are
forwarded to FacturAPI, and the buffers are dropped. No database write. No
disk write. No log write.

Verifiable in code:

| Control | Location | What it enforces |
|---|---|---|
| Upload route auth | `server/routes/cfdi.js:103` (`requireAuth('manage_invoicing')`) | Only tenant members with `manage_invoicing` permission can upload. |
| Memory-only buffers | `server/routes/cfdi.js:22` (`multer.memoryStorage()`) | No tmp file on disk. Buffers live only in the request's lifetime. |
| Size cap | `server/routes/cfdi.js:22` (`limits: { fileSize: 50 * 1024 }`) | Rejects anything > 50 KB. Real CSD files are < 5 KB. |
| Password passthrough | `server/helpers/facturapi.js:96-110` (`uploadCSD()`) | Password arrives as `req.body.password`, forwarded to FacturAPI, never written to DB or log. |
| No CSD columns | `server/db/pg-schema.sql` (schema search for `csd_cer`, `csd_key`, `csd_password` returns zero hits) | Table `cfdi_config` only stores a boolean `csd_uploaded` flag and the FacturAPI `org_id`. The certificate itself lives in FacturAPI. |

**Custody boundary:** once `uploadCSD()` returns, the CSD exists in two places
only — the tenant's local machine (where they got the files from the SAT
portal) and FacturAPI's vault. pos-lite has no copy.

---

## What pos-lite *does* hold (and how it's protected)

`tenant_credentials` table (`server/db/pg-schema.sql:607`) stores per-tenant
API secrets for **FacturAPI** and **Stripe** — not CSDs. As of 2026-04-21
these are plaintext; **CP5 (Phase 1)** encrypts them with pgcrypto
(`pgp_sym_encrypt`/`pgp_sym_decrypt`), master key in Railway env. Once CP5
ships, the row-at-rest is ciphertext.

Row Level Security is enforced on `tenant_credentials`
(`server/db/pg-schema.sql:721`) so even a compromised tenant session cannot
read another tenant's secrets.

---

## Rotation procedure

Rotate the CSD when any of these happen:

1. **SAT expiration** — CSDs expire every 4 years. FacturAPI reports the
   expiry via `testStamp()` (`server/helpers/facturapi.js:117-129`). Rotate
   ≥ 30 days before expiry.
2. **Suspected leak** — any incident where the `.cer`, `.key`, or password
   may have been exposed (lost laptop, shared over insecure channel, etc.).
3. **Personnel change** — a person with custody of the CSD leaves the
   restaurant.

**Steps:**

1. Restaurant generates a new CSD in the [SAT portal](https://www.sat.gob.mx/)
   (requires the restaurant's FIEL).
2. Restaurant revokes the old CSD in the SAT portal.
3. Tenant member with `manage_invoicing` uploads the new CSD via
   `POST /api/cfdi/config/csd` (routed through `/admin` in the UI).
4. pos-lite calls `uploadCSD()` which replaces the CSD in the FacturAPI
   organization.
5. Test with `POST /api/cfdi/config/test` (`/config/test` endpoint,
   `cfdi.js:137`). A `success: true` with a future `expires_at` confirms
   the rotation.

No pos-lite database changes required. The `csd_uploaded` flag stays `true`.

---

## Incident response

**Trigger:** credible evidence or suspicion that a tenant's CSD has been
exposed.

1. **Within 1 hour** — Juan contacts the tenant and instructs them to revoke
   the CSD at the SAT portal (highest priority; stops fraudulent issuance).
2. **Within 4 hours** — rotate to a fresh CSD per the Rotation Procedure above.
3. **Within 24 hours** — review `audit_log` for unexpected CFDI issuance in
   the window between suspected exposure and revocation
   (`SELECT * FROM cfdi_invoices WHERE tenant_id = $1 AND issued_at > $2`).
   Any invoice the tenant does not recognize is reported to the SAT.
4. **Post-incident** — document what happened in
   `~/.gstack/projects/juanpasaflipz-pos-lite/incidents/` with date, tenant
   (hashed if shared), suspected vector, and remediation.

**Break-glass contact:** Juan (juan@injupe.com, WhatsApp +52 ...). Tenant
should have this on file via the CP4 break-glass contingency doc signed
before Phase 1 service begins.

---

## What this policy does NOT cover (scope honesty)

- **FacturAPI's internal handling of the CSD.** That is FacturAPI's
  responsibility under their own security posture. pos-lite's guarantee
  ends at the custody boundary.
- **Transport security.** TLS is handled by Railway's ingress. Assumed
  in-scope but not a CSD-specific control.
- **Tenant-side hygiene.** If a restaurant emails their `.key` file to
  themselves over unencrypted Gmail, that is out of our control. The
  break-glass doc (CP4) surfaces this expectation to the design partner
  in plain language.

---

## Changelog

- **1.0 — 2026-04-21** — initial policy written under `/plan-eng-review`
  amendments (CP2 simplified after code audit confirmed delegation to
  FacturAPI + memory-only buffers).
