// Firing the kitchen ticket, one tap after the cart.
//
// This is the moment the order stops being local state and becomes a row the
// restaurant is acting on. It fires on the "¿para aquí o para llevar?" answer
// rather than at the end of the flow, so the line starts cooking while the guest
// is still typing their name.
//
// Why here and not one screen earlier, on the cart's own button: the two
// questions that used to precede order creation are not equivalent. Fulfillment
// is a packaging instruction — a ticket carrying the wrong one is an error the
// line cannot see. The call-out name is a label, and the KDS has always rendered
// a nameless ticket as its order number. So the instruction is answered before
// the ticket exists and only the label is deferred, to identifyKioskOrder().
//
// It lives here because there are two carts — the grid cart and the wizard
// summary — feeding one fulfillment screen. A copy that drifts is how one kiosk
// mode quietly stops reporting suggestion conversions.
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
): Promise<KioskOpenOrder> {
  const order = await sendKioskOrderToKitchen(
    auth,
    lines.map((line) => ({
      menu_item_id: line.menu_item_id,
      quantity: line.quantity,
      modifier_ids: line.modifiers.map((m) => m.id),
    })),
    { customerToken: session?.customerToken ?? null, fulfillmentType, identifyLater: true },
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
