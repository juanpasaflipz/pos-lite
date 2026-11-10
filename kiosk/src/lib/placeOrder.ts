// Firing the kitchen ticket from the cart.
//
// This is the moment the order stops being local state and becomes a row the
// restaurant is acting on. The cart screen asks "¿para aquí o para llevar?" and
// (optionally) the call-out name itself, so one tap on Pagar creates the order
// with both and moves straight to payment.
//
// The two answers are not equivalent, and the cart treats them differently:
//   - Fulfillment is a packaging instruction — a ticket carrying the wrong one
//     is an error the line cannot see. It is REQUIRED before Pagar unlocks and
//     is never defaulted.
//   - The call-out name is a label, and the KDS has always rendered a nameless
//     ticket as its order number. It is optional.
// `identifyLater` stays on purely to skip the server's name guard for a blank
// name; nothing is patched on afterwards.

import {
  logSuggestionEvents,
  sendKioskOrderToKitchen,
  type AuthHeaders,
  type KioskOpenOrder,
} from './kioskApi';
import { orderedSuggestionEvents } from './suggestionTelemetry';
import type { KioskCartLine, KioskFulfillmentType } from '../context/KioskCartContext';
import type { CustomerSession } from '../context/KioskCustomerContext';

export async function fireKioskOrder(
  auth: AuthHeaders,
  lines: KioskCartLine[],
  session: CustomerSession | null | undefined,
  fulfillmentType: KioskFulfillmentType,
  callName: string | null = null,
): Promise<KioskOpenOrder> {
  const order = await sendKioskOrderToKitchen(
    auth,
    lines.map((line) => ({
      menu_item_id: line.menu_item_id,
      quantity: line.quantity,
      modifier_ids: line.modifiers.map((m) => m.id),
    })),
    {
      customerToken: session?.customerToken ?? null,
      customerCallName: callName || undefined,
      fulfillmentType,
      identifyLater: true,
    },
  );

  // Fire-and-forget; logSuggestionEvents swallows its own failures. Reported
  // here rather than at payment because this is where the order exists — an
  // abandoned-before-paying order still converted a suggestion.
  logSuggestionEvents(auth, session?.customerToken ?? null, orderedSuggestionEvents(session, lines));

  return {
    id: order.id,
    order_number: order.order_number,
    subtotal: order.subtotal,
    tax: order.tax,
    total: order.total,
    status: order.status,
    payment_status: order.payment_status,
    customer_call_name: order.customer_call_name,
    order_fulfillment_type: order.order_fulfillment_type,
    created_at: new Date().toISOString(),
    items: lines.map((line, idx) => ({
      order_item_id: idx + 1,
      menu_item_id: line.menu_item_id,
      item_name: line.name,
      quantity: line.quantity,
      unit_price: line.price,
      modifiers: line.modifiers,
    })),
  };
}
