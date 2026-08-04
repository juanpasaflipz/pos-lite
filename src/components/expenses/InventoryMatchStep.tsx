import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Package, X, ChevronDown } from 'lucide-react';
import {
  searchInventory,
  getInventory,
  type InventoryMatch,
  type InventorySearchResult,
} from '../../api';

interface ParsedItem {
  description: string;
  amount: number;
  quantity?: number | null;
  unit?: string | null;
  pack_size?: number | null;
  unit_price?: number | null;
}

interface Props {
  items: ParsedItem[];
  onContinue: (matches: InventoryMatch[]) => void;
  onSkipAll: () => void;
}

function unitsCompatible(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function defaultQuantityFor(parsed: ParsedItem, inv: InventorySearchResult | null): number {
  if (!inv) return 0;
  const parsedQty = Number(parsed.quantity) || 1;
  const parsedPack = Number(parsed.pack_size) || 1;
  const invPack = Number(inv.pack_size) || 1;

  // If receipt and inventory use the same unit, restock parsed_qty * parsed_pack (in that unit)
  if (unitsCompatible(parsed.unit, inv.unit) && parsed.pack_size) {
    return parsedQty * parsedPack;
  }
  // If inventory is tracked by pack (e.g. "cases") and receipt has same unit, multiply by inv pack_size
  if (parsed.pack_size && invPack) {
    return parsedQty * parsedPack;
  }
  return parsedQty;
}

interface ItemMatchState {
  selectedItem: InventorySearchResult | null;
  quantity: number;
  searchQuery: string;
  searchResults: InventorySearchResult[];
  showDropdown: boolean;
  searching: boolean;
}

const InventoryMatchStep: React.FC<Props> = ({ items, onContinue, onSkipAll }) => {
  const { t } = useTranslation('admin');
  const [matchStates, setMatchStates] = useState<ItemMatchState[]>([]);
  const [allInventory, setAllInventory] = useState<InventorySearchResult[]>([]);
  const searchTimeouts = useRef<(ReturnType<typeof setTimeout> | null)[]>([]);

  // Fetch full inventory list for auto-matching on mount
  useEffect(() => {
    getInventory()
      .then((inv) => {
        const mapped: InventorySearchResult[] = inv.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          unit: i.unit || '',
          cost_price: i.cost_price || 0,
          category: i.category || '',
          pack_size: i.pack_size ?? null,
        }));
        setAllInventory(mapped);
      })
      .catch(() => {});
  }, []);

  // Initialize match states when items or inventory arrive
  useEffect(() => {
    if (items.length === 0) return;

    setMatchStates(
      items.map((item) => {
        const autoMatch = allInventory.length > 0 ? fuzzyMatch(item.description, allInventory) : null;
        return {
          selectedItem: autoMatch,
          quantity: defaultQuantityFor(item, autoMatch),
          searchQuery: '',
          searchResults: [],
          showDropdown: false,
          searching: false,
        };
      })
    );
  }, [items, allInventory]);

  const updateState = useCallback(
    (index: number, updates: Partial<ItemMatchState>) => {
      setMatchStates((prev) => {
        const next = [...prev];
        next[index] = { ...next[index], ...updates };
        return next;
      });
    },
    []
  );

  const handleSearch = useCallback(
    (index: number, query: string) => {
      updateState(index, { searchQuery: query, showDropdown: true });

      // Clear previous timeout
      if (searchTimeouts.current[index]) {
        clearTimeout(searchTimeouts.current[index]!);
      }

      if (query.trim().length === 0) {
        // Show recent/all inventory when empty
        updateState(index, { searchResults: allInventory.slice(0, 10), searching: false });
        return;
      }

      updateState(index, { searching: true });
      searchTimeouts.current[index] = setTimeout(async () => {
        try {
          const results = await searchInventory(query);
          updateState(index, { searchResults: results, searching: false });
        } catch {
          updateState(index, { searchResults: [], searching: false });
        }
      }, 300);
    },
    [allInventory, updateState]
  );

  const handleSelectItem = useCallback(
    (index: number, item: InventorySearchResult | null) => {
      const parsed = items[index];
      updateState(index, {
        selectedItem: item,
        quantity: item ? defaultQuantityFor(parsed, item) : 0,
        showDropdown: false,
        searchQuery: '',
      });
    },
    [items, updateState]
  );

  const handleContinue = () => {
    const matches: InventoryMatch[] = matchStates
      .map((s, idx) => ({ state: s, parsed: items[idx] }))
      .filter(({ state }) => state.selectedItem && state.quantity > 0)
      .map(({ state, parsed }) => ({
        inventory_item_id: state.selectedItem!.id,
        inventory_item_name: state.selectedItem!.name,
        quantity: state.quantity,
        cost_price: parsed.amount ? parsed.amount / (state.quantity || 1) : undefined,
        raw_description: parsed.description,
      }));
    onContinue(matches);
  };

  if (matchStates.length === 0) return null;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-bold text-white">{t('expenses.matchToInventory')}</h3>
        <p className="text-sm text-neutral-400 mt-0.5">
          {t('expenses.matchToInventoryHint')}
        </p>
      </div>

      <div className="space-y-3">
        {items.map((item, index) => (
          <MatchRow
            key={index}
            parsedItem={item}
            state={matchStates[index]}
            allInventory={allInventory}
            onSearch={(q) => handleSearch(index, q)}
            onSelect={(inv) => handleSelectItem(index, inv)}
            onQuantityChange={(qty) => updateState(index, { quantity: qty })}
            onToggleDropdown={(show) => updateState(index, { showDropdown: show })}
          />
        ))}
      </div>

      <div className="flex gap-3 pt-1">
        <button
          onClick={onSkipAll}
          className="flex-1 py-3 bg-neutral-800 text-white font-semibold rounded-lg hover:bg-neutral-700 transition-colors"
        >
          {t('expenses.skipAll')}
        </button>
        <button
          onClick={handleContinue}
          className="flex-1 py-3 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 transition-colors"
        >
          {t('expenses.continue')}
        </button>
      </div>
    </div>
  );
};

/* ==================== Individual Match Row ==================== */

interface MatchRowProps {
  parsedItem: ParsedItem;
  state: ItemMatchState;
  allInventory: InventorySearchResult[];
  onSearch: (query: string) => void;
  onSelect: (item: InventorySearchResult | null) => void;
  onQuantityChange: (qty: number) => void;
  onToggleDropdown: (show: boolean) => void;
}

const MatchRow: React.FC<MatchRowProps> = ({
  parsedItem,
  state,
  allInventory,
  onSearch,
  onSelect,
  onQuantityChange,
  onToggleDropdown,
}) => {
  const { t } = useTranslation('admin');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        onToggleDropdown(false);
      }
    };
    if (state.showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [state.showDropdown, onToggleDropdown]);

  const rawDisplayResults =
    state.searchResults.length > 0
      ? state.searchResults
      : state.searchQuery.trim().length === 0
        ? allInventory.slice(0, 10)
        : [];

  // Both layers stay matchable on purpose: most receipt lines restock the
  // walk-in, but some things arrive sellable-as-counted (bottled drinks,
  // supplier-made tamales) and belong straight on the line. Components sort
  // first because picking one is the less obvious, more deliberate choice.
  const displayResults = [...rawDisplayResults].sort((a, b) => {
    const rank = (i: typeof a) => ((i.kind || 'raw') === 'component' ? 0 : 1);
    return rank(a) - rank(b);
  });

  return (
    <div className="bg-neutral-800/50 rounded-lg p-3 space-y-2">
      {/* Parsed item info */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm text-white font-medium truncate">
            {parsedItem.description}
          </div>
          {(parsedItem.quantity || parsedItem.unit) && (
            <div className="text-xs text-neutral-500 truncate">
              {parsedItem.quantity ?? '?'}
              {parsedItem.pack_size ? ` × ${parsedItem.pack_size}` : ''}
              {parsedItem.unit ? ` ${parsedItem.unit}` : ''}
              {parsedItem.unit_price ? ` @ $${Number(parsedItem.unit_price).toFixed(2)}` : ''}
            </div>
          )}
        </div>
        <span className="text-sm text-neutral-400 shrink-0">
          ${Number(parsedItem.amount).toFixed(2)}
        </span>
      </div>

      {/* Inventory search dropdown */}
      <div className="relative" ref={dropdownRef}>
        {state.selectedItem ? (
          <button
            onClick={() => {
              onSelect(null);
              onToggleDropdown(true);
              setTimeout(() => inputRef.current?.focus(), 50);
            }}
            className="w-full flex items-center justify-between px-3 py-2.5 bg-brand-600/20 border border-brand-600/40 rounded-lg text-sm text-left min-h-[44px]"
          >
            <div className="flex items-center gap-2 truncate">
              <Package size={14} className="text-brand-400 shrink-0" />
              <span className="text-brand-300 truncate">{state.selectedItem.name}</span>
            </div>
            <X size={14} className="text-brand-400 shrink-0 ml-2" />
          </button>
        ) : (
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
            <input
              ref={inputRef}
              type="text"
              placeholder={t('expenses.searchInventory')}
              value={state.searchQuery}
              onChange={(e) => onSearch(e.target.value)}
              onFocus={() => {
                onToggleDropdown(true);
                if (state.searchQuery.trim().length === 0) {
                  onSearch('');
                }
              }}
              className="w-full pl-9 pr-8 py-2.5 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white placeholder-neutral-500 focus:border-brand-500 focus:outline-none min-h-[44px]"
            />
            <ChevronDown
              size={14}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500"
            />
          </div>
        )}

        {/* Dropdown results */}
        {state.showDropdown && !state.selectedItem && (
          <div className="absolute z-20 mt-1 w-full bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl max-h-48 overflow-y-auto">
            {/* Skip option */}
            <button
              onClick={() => {
                onSelect(null);
                onToggleDropdown(false);
              }}
              className="w-full text-left px-3 py-2.5 text-sm text-neutral-400 hover:bg-neutral-700 transition-colors min-h-[44px]"
            >
              -- {t('expenses.skip')} --
            </button>

            {state.searching && (
              <div className="px-3 py-2.5 text-sm text-neutral-500">{t('expenses.searching')}</div>
            )}

            {!state.searching && displayResults.length === 0 && state.searchQuery.trim().length > 0 && (
              <div className="px-3 py-2.5 text-sm text-neutral-500">{t('expenses.noMatchesFound')}</div>
            )}

            {displayResults.map((inv) => (
              <button
                key={inv.id}
                onClick={() => onSelect(inv)}
                className="w-full text-left px-3 py-2.5 hover:bg-neutral-700 transition-colors min-h-[44px]"
              >
                <div className="text-sm text-white flex items-center gap-1.5">
                  {inv.name}
                  {inv.kind === 'component' && (
                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-brand-600/20 text-brand-300">
                      {t('inventory:inventory.kinds.component')}
                    </span>
                  )}
                </div>
                <div className="text-xs text-neutral-500">
                  {inv.quantity} {inv.unit} {t('expenses.inStock')}
                  {inv.category ? ` · ${inv.category}` : ''}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Quantity input — only when matched */}
      {state.selectedItem && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-neutral-400">{t('expenses.qty')}:</label>
          <input
            type="number"
            inputMode="decimal"
            min={0.01}
            step="any"
            value={state.quantity || ''}
            onChange={(e) => onQuantityChange(parseFloat(e.target.value) || 0)}
            className="w-20 px-2 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-white text-center focus:border-brand-500 focus:outline-none min-h-[44px]"
          />
          <span className="text-xs text-neutral-400">{state.selectedItem.unit || 'units'}</span>
        </div>
      )}
    </div>
  );
};

/* ==================== Fuzzy Match Helper ==================== */

function fuzzyMatch(
  description: string,
  inventory: InventorySearchResult[]
): InventorySearchResult | null {
  const desc = description.toLowerCase();
  let bestMatch: InventorySearchResult | null = null;
  let bestScore = 0;

  for (const item of inventory) {
    const name = item.name.toLowerCase();
    // Check if any word from the inventory name appears in the description
    const words = name.split(/\s+/);
    let score = 0;
    for (const word of words) {
      if (word.length >= 3 && desc.includes(word)) {
        score += word.length;
      }
    }
    // Also check reverse: description words in inventory name
    const descWords = desc.split(/\s+/);
    for (const word of descWords) {
      if (word.length >= 3 && name.includes(word)) {
        score += word.length;
      }
    }
    if (score > bestScore && score >= 3) {
      bestScore = score;
      bestMatch = item;
    }
  }

  return bestMatch;
}

export default InventoryMatchStep;
