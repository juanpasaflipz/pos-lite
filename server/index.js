import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, adminSql, shutdown as shutdownDb } from './db/index.js';
import { initMigrations, runMigrations } from './db/migrate.js';
import { tenantMiddleware } from './middleware/tenant.js';
import { startAutoCompleteSweep, stopAutoCompleteSweep } from './lib/autoCompleteReadyOrders.js';
import { startRewardReminderSweep, stopRewardReminderSweep } from './lib/rewardRedemptionReminders.js';
import { startWinbackSweep, stopWinbackSweep } from './lib/winbackReminders.js';
import { startPostOrderReviewSweep, stopPostOrderReviewSweep } from './lib/postOrderReviewReminders.js';
import { startPrunePrintJobsSweep, stopPrunePrintJobsSweep } from './lib/pruneOldPrintJobs.js';
import { startTrialSweep, stopTrialSweep } from './lib/trialReminders.js';
import { startSentinelSweep, stopSentinelSweep } from './sentinel/sweep.js';

// ==================== Route Imports (Lean POS) ====================

// Core
import menuRoutes from './routes/menu.js';
import ordersRoutes from './routes/orders.js';
import paymentsRoutes, { mpOAuthCallback, mpWebhook } from './routes/payments.js';
import paymentGroupsRoutes from './routes/payment-groups.js';
import inventoryRoutes from './routes/inventory.js';
import inventoryScanRoutes from './routes/inventory-scan.js';
import employeesRoutes from './routes/employees.js';
import shiftsRoutes from './routes/shifts.js';
import payrollRoutes from './routes/payroll.js';
import reportsRoutes from './routes/reports.js';
import modifiersRoutes from './routes/modifiers.js';
import combosRoutes from './routes/combos.js';
import printersRoutes from './routes/printers.js';
import printJobsRoutes from './routes/print-jobs.js';
import orderTemplatesRoutes from './routes/order-templates.js';
import wasteRoutes from './routes/waste.js';
import expensesRoutes from './routes/expenses.js';
import recurringExpensesRoutes from './routes/recurring-expenses.js';
import purchaseOrdersRoutes from './routes/purchase-orders.js';
import loyaltyRoutes from './routes/loyalty.js';
import walletRoutes from './routes/wallet.js';

// Delivery
import deliveryRoutes from './routes/delivery.js';
import manualSalesRoutes from './routes/manual-sales.js';
import deliveryIntelRoutes from './routes/delivery-intelligence.js';
import uberDirectRoutes from './routes/uber-direct.js';
import getnetRoutes from './routes/getnet.js';
import getnetWebhook from './routes/getnetWebhook.js';
import uploadsRoutes from './routes/uploads.js';

// Auth & Account
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import brandingRoutes from './routes/branding.js';
import credentialsRoutes from './routes/credentials.js';
import whatsappRoutes from './routes/whatsapp.js';
import onboardingRoutes from './routes/onboarding.js';

// Billing & Admin
import billingRoutes, { stripeWebhook, promoValidateHandler } from './routes/billing.js';
import adminRoutes from './routes/admin.js';
import orgRoutes from './routes/org.js';
import demoDataRoutes from './routes/demo-data.js';
import demoProvisionRoutes from './routes/demo-provision.js';
import publicCheckoutRoutes from './routes/public-checkout.js';

// Invoicing (CFDI)
import cfdiRoutes from './routes/cfdi.js';
import cfdiPublicRoutes from './routes/cfdi-public.js';
import receiptsPublicRoutes from './routes/receipts-public.js';
import publicReviewRoutes from './routes/public-review.js';
import loyaltyJoinPublicRoutes from './routes/loyalty-join-public.js';

// Customer-facing
import customerOrderRoutes from './routes/customer-order.js';
import menuBoardRoutes from './routes/menu-board.js';
import displayAssetsRoutes from './routes/display-assets.js';
import kioskRoutes from './routes/kiosk.js';
import devicesRoutes from './routes/devices.js';

// AI Agent
import agentRoutes from './agent/route.js';
import aiRoutes from './routes/ai.js';
import sentinelRoutes from './sentinel/route.js';

// Twilio inbound (WhatsApp voice ops — platform-level webhook)
import twilioInboundRoutes from './routes/twilio-inbound.js';

// Meta Cloud API inbound (coexistence WhatsApp number — platform-level webhook)
import waCloudInboundRoutes from './routes/wa-cloud-inbound.js';

// WhatsApp Embedded Signup onboarding (admin-only, ADMIN_SECRET gated)
import waOnboardingRoutes from './routes/wa-onboarding.js';
import { APP_BUILD, MIN_CLIENT_VERSION, versionPayload } from './helpers/appVersion.js';

// ==================== App Setup ====================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Request ID for tracing
app.use((req, _res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  next();
});

// CORS
const CORS_ORIGIN_REGEX = /^(https?:\/\/(.*\.desktop\.kitchen|localhost(:\d+)?)|capacitor:\/\/localhost)$/;
app.use(cors({
  origin(origin, cb) {
    if (!origin || CORS_ORIGIN_REGEX.test(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  // The Capacitor kiosk talks cross-origin; without this it cannot read the
  // version headers and would never notice a new deploy.
  exposedHeaders: ['X-App-Version', 'X-App-Min-Version'],
}));

// Stripe webhook needs raw body (before express.json)
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

// Capture raw body for webhook signature verification (delivery webhooks)
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    if (
      req.url?.startsWith('/api/delivery/webhook') ||
      req.url?.startsWith('/api/uber-direct/webhook') ||
      req.url?.startsWith('/api/wa-cloud/webhook')
    ) {
      req.rawBody = buf;
    }
  },
}));

app.use(express.static(path.join(__dirname, '../dist')));
app.use('/kiosk', express.static(path.join(__dirname, '../dist-kiosk')));
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));

// ==================== Health Check ====================

app.get('/health', async (_req, res) => {
  try {
    await adminSql`SELECT 1`;
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'unreachable' });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    await adminSql`SELECT 1`;
    res.json({ ok: true, db: 'connected' });
  } catch {
    res.status(503).json({ ok: false, db: 'unreachable' });
  }
});

// ==================== Rate Limiting ====================

const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api', globalApiLimiter);
app.use('/admin', globalApiLimiter);

// ==================== App Version ====================
// Every /api response carries the build the server is serving, so clients
// detect a new deploy off traffic they were already making — no extra polling
// on the hot path. Mounted before tenantMiddleware: version is not tenant data
// and must not open a DB transaction.
app.use('/api', (_req, res, next) => {
  res.set('X-App-Version', APP_BUILD.buildId);
  if (MIN_CLIENT_VERSION) res.set('X-App-Min-Version', MIN_CLIENT_VERSION);
  next();
});

app.get('/api/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(versionPayload());
});

// ==================== Pre-Tenant Routes ====================

// WhatsApp Embedded Signup onboarding (own ADMIN_SECRET gate; mounted before
// adminRoutes so it isn't swallowed by that router's JSON-only handlers)
app.use('/admin/wa-onboarding', waOnboardingRoutes);

// Admin (uses admin pool, not tenant-scoped)
app.use('/admin', adminRoutes);

// Auth (uses admin pool for registration/login)
app.use('/api/auth', authRoutes);

// CFDI public self-service (token-based, no auth)
app.use('/api/cfdi-public', cfdiPublicRoutes);

// Public SMS receipt links (token-based, no auth)
app.use('/api/public/receipts', receiptsPublicRoutes);

// Public post-order loyalty enrollment (kiosk QR self-service, token-based)
app.use('/api/loyalty-join', loyaltyJoinPublicRoutes);

// Public Google review redirect ({subdomain}.desktop.kitchen/gr → real
// Google review URL). Owns the SMS short link so we skip TinyURL's
// interstitial and iOS's underscore-URL-parsing bug on raw g.page URLs.
app.use('/', publicReviewRoutes);

// Corporate dashboard (cross-tenant by design — org JWT auth, admin pool,
// read-only aggregates scoped by tenants.org_id; see routes/org.js)
app.use('/api/org', orgRoutes);

// Kiosk bind (cross-tenant PIN search, no tenant header required)
app.use('/api/kiosk', kioskRoutes);

// Payment webhooks (before tenant middleware — cross-tenant)
app.get('/api/payments/mp/callback', mpOAuthCallback);
app.post('/api/payments/mp/webhook', mpWebhook);
app.use('/webhooks/getnet', getnetWebhook);

// Twilio inbound (WhatsApp voice ops — uses urlencoded body, no tenant)
app.use('/api/twilio', twilioInboundRoutes);

// Meta Cloud API inbound (coexistence number voice ops — JSON body with
// X-Hub-Signature-256 over the raw bytes; rawBody captured above, no tenant)
app.use('/api/wa-cloud', waCloudInboundRoutes);

// Promo code validation (public)
app.get('/api/billing/promo/validate', promoValidateHandler);

// Pay-first public checkout (landing page "Comprar" button → Stripe → auto-provision)
app.use('/api/public/checkout', publicCheckoutRoutes);

// Demo provisioning (public)
app.use('/api/demo', demoProvisionRoutes);
app.post('/api/auth/demo-login', (req, res, next) => {
  req.url = '/demo-login';
  demoProvisionRoutes(req, res, next);
});

// Lead capture (public — used by marketing landing pages)
app.post('/api/leads', async (req, res) => {
  try {
    const { restaurant_name, name, email, phone, promo_code, source } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });
    const cleanEmail = email.trim().toLowerCase();
    const existing = await adminSql`SELECT id FROM leads WHERE email = ${cleanEmail}`;
    if (existing.length > 0) {
      await adminSql`
        UPDATE leads SET
          restaurant_name = COALESCE(${restaurant_name || null}, restaurant_name),
          name = COALESCE(${name || null}, leads.name),
          phone = COALESCE(${phone || null}, phone),
          source = COALESCE(${source || null}, source)
        WHERE email = ${cleanEmail}
      `;
      return res.json({ ok: true, existing: true });
    }
    await adminSql`
      INSERT INTO leads (restaurant_name, name, email, phone, source)
      VALUES (${restaurant_name || null}, ${name || null}, ${cleanEmail}, ${phone || null}, ${source || 'landing'})
    `;
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[Leads] Error:', err.message);
    res.status(500).json({ error: 'Failed to save lead' });
  }
});

// ==================== Tenant Middleware ====================

app.use('/api', tenantMiddleware);

// ==================== Tenant-Scoped Routes ====================

// Customer-facing (public, QR code)
app.use('/api/customer-order', customerOrderRoutes);
app.use('/api/menu-board', menuBoardRoutes);

// Core POS
app.use('/api/uploads', uploadsRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/payment-groups', paymentGroupsRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/inventory-scan', inventoryScanRoutes);
app.use('/api/employees', employeesRoutes);
app.use('/api/shifts', shiftsRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/modifiers', modifiersRoutes);
app.use('/api/combos', combosRoutes);
app.use('/api/printers', printersRoutes);
app.use('/api/print-jobs', printJobsRoutes);
app.use('/api/order-templates', orderTemplatesRoutes);
app.use('/api/waste', wasteRoutes);
app.use('/api/expenses', expensesRoutes);
app.use('/api/recurring-expenses', recurringExpensesRoutes);
app.use('/api/purchase-orders', purchaseOrdersRoutes);
app.use('/api/loyalty', loyaltyRoutes);
// Wallet passes: staff enroll + public capability URLs + Apple PassKit web
// service callbacks (Apple calls the tenant subdomain, so tenant middleware
// and RLS scope these automatically).
app.use('/api/wallet', walletRoutes);

// Delivery
app.use('/api/delivery', deliveryRoutes);
app.use('/api/manual-sales', manualSalesRoutes);
app.use('/api/delivery-intel', deliveryIntelRoutes);
app.use('/api/uber-direct', uberDirectRoutes);
// Getnet is still under processor approval. Keep the code, but leave the
// routes DORMANT until GETNET_ENABLED=on — the /tap-charge surface currently
// trusts a client-asserted payment id (no server-side verify yet), so it must
// not be reachable in production before the real verify path lands.
if (process.env.GETNET_ENABLED === 'on') {
  app.use('/api/getnet', getnetRoutes);
} else {
  console.log('[Getnet] routes dormant — set GETNET_ENABLED=on to activate once approved');
}

// Account & Settings
app.use('/api/branding', brandingRoutes);
app.use('/api/display-assets', displayAssetsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/credentials', credentialsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/devices', devicesRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/demo-data', demoDataRoutes);

// Invoicing
app.use('/api/cfdi', cfdiRoutes);

// AI Agent
app.use('/api/agent', agentRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/sentinel', sentinelRoutes);

// ==================== SPA Fallback ====================

app.get('/kiosk/*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../dist-kiosk/index.html'));
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// ==================== Error Handler ====================

app.use((err, req, res, _next) => {
  console.error(`[${req.id}] ${req.method} ${req.path} tenant=${req.tenant?.id || 'none'}:`, err.message || err);
  if (err.stack) console.error(`[${req.id}] Stack:`, err.stack);
  res.status(err.status || err.statusCode || 500).json({
    error: err.expose ? err.message : 'Internal server error',
  });
});

// ==================== Startup Validation ====================

if (process.env.NODE_ENV === 'production') {
  const required = ['JWT_SECRET', 'ADMIN_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`FATAL: Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Recommended-but-not-fatal. When MP_WEBHOOK_SECRET is unset the Mercado Pago
  // webhook falls back to fail-open signature handling (mitigated by a live
  // re-pull of the order from MP before trusting it — see payments.js:2007). Warn
  // loudly at boot so the gap is visible. Once the value is set in the
  // environment, promote it into the `required` array above to fail-fast.
  const recommended = ['MP_WEBHOOK_SECRET'];
  const missingRecommended = recommended.filter(k => !process.env[k]);
  if (missingRecommended.length > 0) {
    console.warn(`WARNING: recommended env var(s) unset: ${missingRecommended.join(', ')} — MP webhook signature verification is disabled (fail-open).`);
  }
}

// ==================== Graceful Shutdown ====================

let server;
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received — shutting down...`);

  if (server) {
    server.close(() => console.log('[Shutdown] HTTP server closed'));
  }

  stopAutoCompleteSweep();
  stopRewardReminderSweep();
  stopWinbackSweep();
  stopPostOrderReviewSweep();
  stopSentinelSweep();
  stopPrunePrintJobsSweep();
  stopTrialSweep();

  await shutdownDb();
  console.log('[Shutdown] Database pools closed');
  process.exit(0);
}

function shutdownWithTimeout(signal) {
  const timer = setTimeout(() => {
    console.error('[Shutdown] Timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  timer.unref();
  gracefulShutdown(signal);
}

process.on('SIGTERM', () => shutdownWithTimeout('SIGTERM'));
process.on('SIGINT', () => shutdownWithTimeout('SIGINT'));

// ==================== Start ====================

(async () => {
  try {
    await initDb();
    await initMigrations();
    await runMigrations('default');

    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`POS Lite server running on port ${PORT} — build ${APP_BUILD.buildId}`);
    });

    startAutoCompleteSweep();
    startRewardReminderSweep();
    startWinbackSweep();
    startPostOrderReviewSweep();
    startSentinelSweep();
    startPrunePrintJobsSweep();
    startTrialSweep();
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
})();
