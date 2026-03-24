import Facturapi from 'facturapi';
import crypto from 'crypto';
import { adminSql } from '../db/index.js';
import { tenantContext } from '../db/index.js';
import { getServiceCredentials } from './tenantCredentials.js';

// ==================== Configuration ====================

const FACTURAPI_API_KEY = process.env.FACTURAPI_API_KEY;
const DEFAULT_EXPIRY_HOURS = parseInt(process.env.CFDI_INVOICE_LINK_EXPIRY_HOURS || '72', 10);

// Platform-level client (used as fallback)
let platformClient = null;
if (FACTURAPI_API_KEY) {
  platformClient = new Facturapi(FACTURAPI_API_KEY);
}

// ==================== Client Resolution ====================

/**
 * Resolve the FacturAPI client for the current tenant (via AsyncLocalStorage).
 * Falls back to platform-level key when no tenant context or no tenant key stored.
 */
async function resolveClient() {
  const tenantId = tenantContext.getStore()?.tenantId;
  if (tenantId) {
    const creds = await getServiceCredentials(tenantId, 'facturapi', {
      api_key: 'FACTURAPI_API_KEY',
    });
    if (creds.api_key) return new Facturapi(creds.api_key);
  }
  if (!platformClient) {
    throw new Error('[FacturAPI] API key not configured. Set FACTURAPI_API_KEY env var or add it in Integrations.');
  }
  return platformClient;
}

// ==================== Client Access ====================

/**
 * Returns true if the FacturAPI API key is configured (platform-level).
 */
export function isFacturapiConfigured() {
  return !!FACTURAPI_API_KEY;
}

/**
 * Returns the platform-level FacturAPI client instance.
 * Throws if the API key is not configured.
 * @deprecated Use the async exported functions instead (they auto-resolve tenant credentials).
 */
export function getFacturapiClient() {
  if (!platformClient) {
    throw new Error('[FacturAPI] API key not configured. Set FACTURAPI_API_KEY env var.');
  }
  return platformClient;
}

// ==================== Organization Management ====================

/**
 * Creates a new FacturAPI organization for a tenant.
 * @param {Object} params
 * @param {string} params.legal_name - Razon social
 * @param {string} params.rfc - RFC del emisor
 * @param {string} params.tax_regime - Regimen fiscal SAT code (e.g. '601')
 * @param {string} params.postal_code - Codigo postal del domicilio fiscal
 * @returns {Object} The created organization object (includes `id`)
 */
export async function createOrganization({ legal_name, rfc, tax_regime, postal_code }) {
  const client = await resolveClient();
  try {
    const org = await client.organizations.create({
      name: legal_name,
      legal_name,
      tax_id: rfc,
      tax_system: tax_regime,
      address: { zip: postal_code },
    });
    console.log(`[FacturAPI] Organization created: ${org.id} (${legal_name})`);
    return org;
  } catch (err) {
    console.error(`[FacturAPI] Failed to create organization for ${rfc}:`, err.message);
    throw err;
  }
}

/**
 * Uploads CSD (Certificado de Sello Digital) to a FacturAPI organization.
 * @param {string} orgId - FacturAPI organization ID
 * @param {Buffer} cerBuffer - .cer file contents as a Node Buffer
 * @param {Buffer} keyBuffer - .key file contents as a Node Buffer
 * @param {string} password - CSD private key password
 * @returns {Object} Upload result from FacturAPI
 */
export async function uploadCSD(orgId, cerBuffer, keyBuffer, password) {
  const client = await resolveClient();
  try {
    const result = await client.organizations.uploadCertificate(orgId, {
      cerFile: cerBuffer,
      keyFile: keyBuffer,
      password,
    });
    console.log(`[FacturAPI] CSD uploaded for org ${orgId}`);
    return result;
  } catch (err) {
    console.error(`[FacturAPI] Failed to upload CSD for org ${orgId}:`, err.message);
    throw err;
  }
}

/**
 * Tests if an organization can stamp invoices by checking CSD certificate status.
 * @param {string} orgId - FacturAPI organization ID
 * @returns {{ success: boolean, expires_at?: string, error?: string }}
 */
export async function testStamp(orgId) {
  try {
    const client = await resolveClient();
    const org = await client.organizations.retrieve(orgId);
    if (org.certificate && org.certificate.is_valid) {
      return { success: true, expires_at: org.certificate.expires_at };
    }
    return { success: false, error: 'CSD not valid or not uploaded' };
  } catch (err) {
    console.error(`[FacturAPI] testStamp failed for org ${orgId}:`, err.message);
    return { success: false, error: err.message };
  }
}

// ==================== Invoice Operations ====================

/**
 * Creates a CFDI 4.0 invoice (Ingreso) via FacturAPI.
 * Uses the platform API key with organization scope.
 *
 * @param {string} orgId - FacturAPI organization ID
 * @param {Object} params
 * @param {Object} params.receptor - Customer/receptor data
 * @param {string} params.receptor.name - Razon social del receptor
 * @param {string} params.receptor.rfc - RFC del receptor
 * @param {string} params.receptor.tax_regime - Regimen fiscal del receptor
 * @param {string} params.receptor.postal_code - Codigo postal del receptor
 * @param {string} [params.receptor.uso_cfdi='G03'] - Uso del CFDI
 * @param {Array} params.items - Pre-mapped CFDI line items (use mapOrderItemsToCFDI)
 * @param {string} params.forma_pago - SAT forma de pago code (use mapPaymentToFormaPago)
 * @param {string} [params.metodo_pago='PUE'] - SAT metodo de pago
 * @param {string} [params.series] - Invoice series
 * @param {number} [params.folio_number] - Folio number
 * @returns {Object} The created invoice object from FacturAPI
 */
export async function createInvoice(orgId, { receptor, items, forma_pago, metodo_pago, series, folio_number }) {
  const client = await resolveClient();

  const invoiceData = {
    type: 'I', // Ingreso
    customer: {
      legal_name: receptor.name,
      tax_id: receptor.rfc,
      tax_system: receptor.tax_regime,
      address: { zip: receptor.postal_code },
    },
    use: receptor.uso_cfdi || 'G03',
    payment_form: forma_pago,
    payment_method: metodo_pago || 'PUE',
    items,
  };

  if (series) invoiceData.series = series;
  if (folio_number != null) invoiceData.folio_number = folio_number;

  try {
    const invoice = await client.invoices.create(invoiceData, { organizationId: orgId });
    console.log(`[FacturAPI] Invoice created: ${invoice.id} (org: ${orgId})`);
    return invoice;
  } catch (err) {
    console.error(`[FacturAPI] Failed to create invoice for org ${orgId}:`, err.message);
    throw err;
  }
}

/**
 * Cancels a CFDI invoice.
 * @param {string} orgId - FacturAPI organization ID (for logging; cancellation uses invoice ID)
 * @param {string} invoiceId - FacturAPI invoice ID
 * @param {string} motive - SAT cancellation motive code ('01'–'04')
 * @param {string} [substituteUUID] - UUID of substitute invoice (required when motive='01')
 * @returns {Object} Cancellation result from FacturAPI
 */
export async function cancelInvoice(orgId, invoiceId, motive, substituteUUID) {
  const client = await resolveClient();

  const cancelParams = { motive };
  if (substituteUUID) {
    cancelParams.substitution = substituteUUID;
  }

  try {
    const result = await client.invoices.cancel(invoiceId, cancelParams);
    console.log(`[FacturAPI] Invoice ${invoiceId} cancelled (org: ${orgId}, motive: ${motive})`);
    return result;
  } catch (err) {
    console.error(`[FacturAPI] Failed to cancel invoice ${invoiceId}:`, err.message);
    throw err;
  }
}

/**
 * Gets download URLs (XML and PDF) for an invoice.
 * @param {string} orgId - FacturAPI organization ID (for logging)
 * @param {string} invoiceId - FacturAPI invoice ID
 * @returns {{ xml_url: string|null, pdf_url: string|null }}
 */
export async function getInvoiceFiles(orgId, invoiceId) {
  const client = await resolveClient();
  try {
    const invoice = await client.invoices.retrieve(invoiceId);
    return {
      xml_url: invoice.xml_url || null,
      pdf_url: invoice.pdf_url || null,
    };
  } catch (err) {
    console.error(`[FacturAPI] Failed to retrieve invoice files for ${invoiceId}:`, err.message);
    throw err;
  }
}

// ==================== Mapping Helpers ====================

/**
 * Maps POS payment method to SAT forma de pago code.
 * @param {string} paymentMethod - POS payment method ('cash', 'card', 'split')
 * @returns {string} SAT forma de pago code
 */
export function mapPaymentToFormaPago(paymentMethod) {
  switch (paymentMethod) {
    case 'cash':   return '01'; // Efectivo
    case 'card':   return '04'; // Tarjeta de credito
    case 'split':  return '99'; // Por definir
    default:       return '99'; // Por definir
  }
}

/**
 * Maps POS order items to FacturAPI CFDI 4.0 line items.
 * Prices in the POS include IVA, so we extract the pre-tax price.
 *
 * @param {Array} orderItems - Order items from the database
 * @param {number} [taxRate=0.16] - IVA tax rate (16% default for Mexico)
 * @returns {Array} FacturAPI-compatible CFDI line items
 */
export function mapOrderItemsToCFDI(orderItems, taxRate = 0.16) {
  return orderItems.map((item) => ({
    product: {
      description: item.item_name,
      product_key: '90101501', // SAT: Servicio de restaurante
      unit_key: 'E48',        // SAT: Unidad de servicio
      unit_name: 'Servicio',
      price: item.unit_price / (1 + taxRate), // Extract pre-tax price (prices include IVA)
      tax_included: false,
      taxes: [
        {
          type: 'IVA',
          rate: taxRate,
        },
      ],
    },
    quantity: item.quantity,
  }));
}

// ==================== Token Management ====================

/**
 * Generates a secure random token for self-service invoice links.
 * Stores the token in `cfdi_invoice_tokens` using adminSql (bypasses RLS).
 *
 * @param {string} tenantId - Tenant UUID
 * @param {number} orderId - Order ID
 * @param {number} [expiryHours] - Token expiry in hours (defaults to CFDI_INVOICE_LINK_EXPIRY_HOURS or 72)
 * @returns {string} The generated token (base64url-encoded)
 */
export async function generateInvoiceToken(tenantId, orderId, expiryHours) {
  const hours = expiryHours || DEFAULT_EXPIRY_HOURS;
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  try {
    await adminSql`
      INSERT INTO cfdi_invoice_tokens (token, tenant_id, order_id, expires_at)
      VALUES (${token}, ${tenantId}, ${orderId}, ${expiresAt})
    `;
    return token;
  } catch (err) {
    console.error(`[FacturAPI] Failed to generate invoice token for order ${orderId}:`, err.message);
    throw err;
  }
}
