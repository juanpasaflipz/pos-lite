// Which personalized suggestions actually converted to an order.
//
// Closes the shown → tapped → ordered loop behind the suggestion-acceptance
// KPI. The 'tapped' half is logged on the menu screen; this builds the
// 'ordered' half by intersecting what the customer was shown with what they
// actually walked out with.
//
// It lives here rather than inside a screen because order creation happens in
// two places — the cart (delivery, which has everything it needs by then) and
// /name (dine-in and takeout, at the end of the flow). Both have to report, and
// a copy that only one of them runs is how this signal quietly goes to zero.
import type { CustomerSession } from '../context/KioskCustomerContext';
import type { SuggestionEvent } from './kioskApi';

interface CartLineLike {
  menu_item_id: number;
}

export function orderedSuggestionEvents(
  session: CustomerSession | null | undefined,
  lines: CartLineLike[],
): SuggestionEvent[] {
  const s = session?.suggestions;
  if (!s) return [];

  const byId = new Map<number, { lane: SuggestionEvent['lane']; source?: string; reason?: string }>();
  const all = [...(s.for_you || []), ...(s.popular || []), ...(s.house ? [s.house] : [])];
  for (const it of all) {
    if (it && !byId.has(it.menu_item_id)) {
      byId.set(it.menu_item_id, { lane: it.lane, source: it.source, reason: it.reason });
    }
  }

  const events: SuggestionEvent[] = [];
  for (const line of lines) {
    const sug = byId.get(line.menu_item_id);
    if (sug) {
      events.push({
        menu_item_id: line.menu_item_id,
        lane: sug.lane,
        source: sug.source,
        event_type: 'ordered',
        reason: sug.reason,
      });
    }
  }
  return events;
}
