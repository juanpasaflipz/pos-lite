// Stub — original AI suggestion system removed from lean POS.
// The new agent co-pilot replaces this functionality via chat interface.

interface UseAISuggestionsOptions {
  cartItemIds: number[];
  employeeId?: number;
  enabled?: boolean;
}

export function useAISuggestions(_opts: UseAISuggestionsOptions) {
  return {
    cartSuggestions: [],
    inventoryPush: null,
    pushItemIds: new Set<number>(),
    avoidItemIds: new Set<number>(),
    soldOutItemIds: new Set<number>(),
    lowStockItemIds: new Set<number>(),
    acceptSuggestion: () => {},
    dismissSuggestion: () => {},
    loading: false,
  };
}
