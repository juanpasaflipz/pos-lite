import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { KioskMenuItem } from '../lib/kioskApi';

export interface KioskCartLine {
  menu_item_id: number;
  name: string;
  price: number;
  quantity: number;
}

export interface KioskLastOrder {
  id: number;
  order_number: string | number;
  total: number;
  payment_status: string;
  payment_choice: 'counter_cash' | 'terminal_card';
}

interface KioskCartState {
  lines: KioskCartLine[];
  count: number;
  total: number;
  lastOrder: KioskLastOrder | null;
  addItem: (item: KioskMenuItem) => void;
  decrementItem: (menuItemId: number) => void;
  removeItem: (menuItemId: number) => void;
  clearCart: () => void;
  setLastOrder: (order: KioskLastOrder | null) => void;
}

const Ctx = createContext<KioskCartState | null>(null);

export const KioskCartProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lines, setLines] = useState<KioskCartLine[]>([]);
  const [lastOrder, setLastOrder] = useState<KioskLastOrder | null>(null);

  const addItem = useCallback((item: KioskMenuItem) => {
    setLines((current) => {
      const existing = current.find((line) => line.menu_item_id === item.id);
      if (existing) {
        return current.map((line) =>
          line.menu_item_id === item.id
            ? { ...line, quantity: Math.min(20, line.quantity + 1) }
            : line,
        );
      }
      return [...current, {
        menu_item_id: item.id,
        name: item.name,
        price: Number(item.price),
        quantity: 1,
      }];
    });
  }, []);

  const decrementItem = useCallback((menuItemId: number) => {
    setLines((current) => current.flatMap((line) => {
      if (line.menu_item_id !== menuItemId) return [line];
      if (line.quantity <= 1) return [];
      return [{ ...line, quantity: line.quantity - 1 }];
    }));
  }, []);

  const removeItem = useCallback((menuItemId: number) => {
    setLines((current) => current.filter((line) => line.menu_item_id !== menuItemId));
  }, []);

  const clearCart = useCallback(() => setLines([]), []);

  const value = useMemo(() => {
    const count = lines.reduce((sum, line) => sum + line.quantity, 0);
    const total = Math.round(lines.reduce((sum, line) => sum + line.price * line.quantity, 0) * 100) / 100;
    return {
      lines,
      count,
      total,
      lastOrder,
      addItem,
      decrementItem,
      removeItem,
      clearCart,
      setLastOrder,
    };
  }, [addItem, clearCart, decrementItem, lastOrder, lines, removeItem]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useKioskCart = (): KioskCartState => {
  const value = useContext(Ctx);
  if (!value) throw new Error('useKioskCart must be used inside KioskCartProvider');
  return value;
};
