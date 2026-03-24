import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import type { CartItem, MenuItem } from '../types';
import { offlineDb } from '../lib/offlineDb';
import { calculateOrderTotals } from '../lib/offlineOrderQueue';

/* ==================== Types ==================== */

interface MobileCartState {
  items: CartItem[];
  tip: number;
  tipPercent: number | null; // null = no tip, 10/15/20
  quickMode: boolean;
}

interface MobileCartDerived {
  itemCount: number;
  subtotal: number;
  tax: number;
  total: number;
  totalWithTip: number;
}

interface MobileCartActions {
  addItem: (item: MenuItem) => void;
  addItemWithModifiers: (
    item: MenuItem,
    modifierIds: number[],
    modifierNames: string[],
    modifierPriceTotal: number,
    notes?: string,
    quantity?: number,
  ) => void;
  removeItem: (cartId: string) => void;
  updateQuantity: (cartId: string, qty: number) => void;
  setTip: (percent: number | null) => void;
  toggleQuickMode: () => void;
  clearCart: () => void;
}

type MobileCartContextType = MobileCartState & MobileCartDerived & MobileCartActions;

/* ==================== Reducer ==================== */

type Action =
  | { type: 'ADD_ITEM'; item: MenuItem }
  | { type: 'ADD_ITEM_WITH_MODIFIERS'; item: MenuItem; modifierIds: number[]; modifierNames: string[]; modifierPriceTotal: number; notes?: string; quantity?: number }
  | { type: 'REMOVE_ITEM'; cartId: string }
  | { type: 'UPDATE_QUANTITY'; cartId: string; qty: number }
  | { type: 'SET_TIP'; percent: number | null }
  | { type: 'TOGGLE_QUICK_MODE' }
  | { type: 'CLEAR_CART' }
  | { type: 'RESTORE_CART'; items: CartItem[] };

function generateCartId(): string {
  return `mcart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function cartReducer(state: MobileCartState, action: Action): MobileCartState {
  switch (action.type) {
    case 'ADD_ITEM': {
      const existing = state.items.find(
        (ci) => ci.menu_item_id === action.item.id && !ci.selectedModifierIds?.length && !ci.combo_instance_id
      );
      if (existing) {
        return {
          ...state,
          items: state.items.map((ci) =>
            ci.cart_id === existing.cart_id ? { ...ci, quantity: ci.quantity + 1 } : ci
          ),
        };
      }
      return {
        ...state,
        items: [
          ...state.items,
          {
            cart_id: generateCartId(),
            menu_item_id: action.item.id,
            item_name: action.item.name,
            quantity: 1,
            unit_price: Number(action.item.price),
            menuItem: action.item,
          },
        ],
      };
    }

    case 'ADD_ITEM_WITH_MODIFIERS': {
      const qty = action.quantity ?? 1;
      return {
        ...state,
        items: [
          ...state.items,
          {
            cart_id: generateCartId(),
            menu_item_id: action.item.id,
            item_name: action.item.name,
            quantity: qty,
            unit_price: Number(action.item.price) + action.modifierPriceTotal,
            menuItem: action.item,
            notes: action.notes,
            selectedModifierIds: action.modifierIds,
            selectedModifierNames: action.modifierNames,
          },
        ],
      };
    }

    case 'REMOVE_ITEM':
      return { ...state, items: state.items.filter((ci) => ci.cart_id !== action.cartId) };

    case 'UPDATE_QUANTITY': {
      if (action.qty <= 0) {
        return { ...state, items: state.items.filter((ci) => ci.cart_id !== action.cartId) };
      }
      return {
        ...state,
        items: state.items.map((ci) =>
          ci.cart_id === action.cartId ? { ...ci, quantity: action.qty } : ci
        ),
      };
    }

    case 'SET_TIP': {
      if (action.percent === null) {
        return { ...state, tip: 0, tipPercent: null };
      }
      const { total } = calculateOrderTotals(state.items);
      const tipAmount = Math.round(total * (action.percent / 100) * 100) / 100;
      return { ...state, tip: tipAmount, tipPercent: action.percent };
    }

    case 'TOGGLE_QUICK_MODE': {
      const next = !state.quickMode;
      localStorage.setItem('mobileQuickMode', next ? '1' : '0');
      return { ...state, quickMode: next };
    }

    case 'CLEAR_CART':
      return { ...state, items: [], tip: 0, tipPercent: null };

    case 'RESTORE_CART':
      return { ...state, items: action.items };

    default:
      return state;
  }
}

/* ==================== Context ==================== */

const MobileCartContext = createContext<MobileCartContextType | null>(null);

export function useMobileCart(): MobileCartContextType {
  const ctx = useContext(MobileCartContext);
  if (!ctx) throw new Error('useMobileCart must be used within MobileCartProvider');
  return ctx;
}

/* ==================== Provider ==================== */

const MOBILE_CART_ID = 2;

export const MobileCartProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, dispatch] = useReducer(cartReducer, {
    items: [],
    tip: 0,
    tipPercent: null,
    quickMode: localStorage.getItem('mobileQuickMode') === '1',
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Restore cart from IndexedDB on mount
  useEffect(() => {
    offlineDb.cart.get(MOBILE_CART_ID).then((saved) => {
      if (saved && saved.items.length > 0) {
        dispatch({ type: 'RESTORE_CART', items: saved.items });
      }
    }).catch(() => {});
  }, []);

  // Persist cart to IndexedDB with 300ms debounce
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (state.items.length > 0) {
        offlineDb.cart.put({ id: MOBILE_CART_ID, items: state.items, updatedAt: Date.now() }).catch(() => {});
      } else {
        offlineDb.cart.delete(MOBILE_CART_ID).catch(() => {});
      }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [state.items]);

  // Recalculate tip when items change (if a percentage is active)
  useEffect(() => {
    if (state.tipPercent !== null && state.items.length > 0) {
      dispatch({ type: 'SET_TIP', percent: state.tipPercent });
    } else if (state.items.length === 0 && state.tip > 0) {
      dispatch({ type: 'SET_TIP', percent: null });
    }
  }, [state.items.length]);

  // Derived values
  const { subtotal, tax, total } = calculateOrderTotals(state.items);
  const totalWithTip = Math.round((total + state.tip) * 100) / 100;
  const itemCount = state.items.reduce((sum, ci) => sum + ci.quantity, 0);

  // Actions
  const addItem = useCallback((item: MenuItem) => dispatch({ type: 'ADD_ITEM', item }), []);
  const addItemWithModifiers = useCallback(
    (item: MenuItem, modifierIds: number[], modifierNames: string[], modifierPriceTotal: number, notes?: string, quantity?: number) =>
      dispatch({ type: 'ADD_ITEM_WITH_MODIFIERS', item, modifierIds, modifierNames, modifierPriceTotal, notes, quantity }),
    [],
  );
  const removeItem = useCallback((cartId: string) => dispatch({ type: 'REMOVE_ITEM', cartId }), []);
  const updateQuantity = useCallback((cartId: string, qty: number) => dispatch({ type: 'UPDATE_QUANTITY', cartId, qty }), []);
  const setTip = useCallback((percent: number | null) => dispatch({ type: 'SET_TIP', percent }), []);
  const toggleQuickMode = useCallback(() => dispatch({ type: 'TOGGLE_QUICK_MODE' }), []);
  const clearCart = useCallback(() => dispatch({ type: 'CLEAR_CART' }), []);

  const value: MobileCartContextType = {
    ...state,
    itemCount,
    subtotal,
    tax,
    total,
    totalWithTip,
    addItem,
    addItemWithModifiers,
    removeItem,
    updateQuantity,
    setTip,
    toggleQuickMode,
    clearCart,
  };

  return <MobileCartContext.Provider value={value}>{children}</MobileCartContext.Provider>;
};
