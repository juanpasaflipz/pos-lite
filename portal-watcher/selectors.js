/**
 * Per-platform portal scraping config.
 *
 * ⚠️ SCAFFOLD: the selectors below are PLACEHOLDERS. They must be tuned
 * against the real merchant portals while logged in (run `node watcher.js
 * --debug` and inspect the HTML dumps in ./debug/).
 *
 * Each platform defines:
 *   url            — the orders page to keep open
 *   extractOrders(page) — returns [{ external_order_id, customer_name,
 *                        delivery_address, items: [{name, quantity, unit_price, notes}], total }]
 *                        for ALL currently visible orders (watcher dedups).
 */

export const PLATFORMS = {
  didi_food: {
    url: 'https://merchant.didi-food.com/', // TODO: confirm orders page URL for MX merchant portal
    async extractOrders(page) {
      // TODO(tune): replace with real selectors from --debug HTML dumps
      return page.$$eval('[class*="order-card"], [class*="orderItem"]', (cards) =>
        cards.map((card) => {
          const text = (sel) => card.querySelector(sel)?.textContent?.trim() || '';
          const id = text('[class*="order-no"], [class*="orderId"]')
            || card.getAttribute('data-order-id') || '';
          const items = Array.from(card.querySelectorAll('[class*="item-row"], [class*="goods"]')).map((row) => {
            const t = row.textContent || '';
            const qtyMatch = t.match(/^\s*[xX]?\s*(\d+)\s*[xX]?\s+/);
            return {
              name: t.replace(/^\s*[xX]?\s*\d+\s*[xX]?\s+/, '').trim().slice(0, 120),
              quantity: qtyMatch ? parseInt(qtyMatch[1]) : 1,
            };
          });
          return {
            external_order_id: id,
            customer_name: text('[class*="customer"], [class*="userName"]') || null,
            delivery_address: null,
            items,
            total: parseFloat(text('[class*="total"]').replace(/[^0-9.]/g, '')) || 0,
          };
        }).filter((o) => o.external_order_id && o.items.length)
      );
    },
  },

  rappi: {
    url: 'https://partners.rappi.com/', // TODO: confirm orders page URL (Rappi Partners portal MX)
    async extractOrders(page) {
      // TODO(tune): replace with real selectors from --debug HTML dumps
      return page.$$eval('[data-testid*="order"], [class*="order-card"]', (cards) =>
        cards.map((card) => {
          const text = (sel) => card.querySelector(sel)?.textContent?.trim() || '';
          const id = text('[class*="order-id"], [data-testid*="order-id"]') || '';
          const items = Array.from(card.querySelectorAll('[class*="product"], [class*="item"]')).map((row) => {
            const t = row.textContent || '';
            const qtyMatch = t.match(/^\s*(\d+)\s*[xX]\s+/);
            return {
              name: t.replace(/^\s*\d+\s*[xX]\s+/, '').trim().slice(0, 120),
              quantity: qtyMatch ? parseInt(qtyMatch[1]) : 1,
            };
          });
          return {
            external_order_id: id.replace(/[^0-9A-Za-z-]/g, ''),
            customer_name: text('[class*="client"], [class*="customer"]') || null,
            delivery_address: null,
            items,
            total: parseFloat(text('[class*="total"]').replace(/[^0-9.]/g, '')) || 0,
          };
        }).filter((o) => o.external_order_id && o.items.length)
      );
    },
  },

  // Uber Eats: once the restaurant onboards, either tune a scraper here
  // (https://merchants.ubereats.com) or — better — request official API access;
  // the webhook integration in the server is already built.
};
