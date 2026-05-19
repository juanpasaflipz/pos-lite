import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { KioskMenuItem, KioskModifier } from '../lib/kioskApi';

export interface KioskCartLine {
  menu_item_id: number;
  name: string;
  price: number; // unit price including modifiers
  quantity: number;
  modifiers: KioskModifier[];
  /** Stable id distinguishing two cart lines for the same menu item with different modifier picks. */
  line_key: string;
}

function modifierKey(menuItemId: number, modifiers: KioskModifier[]): string {
  if (!modifiers.length) return `m${menuItemId}`;
  const ids = modifiers.map((m) => m.id).sort((a, b) => a - b).join('_');
  return `m${menuItemId}:${ids}`;
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
  addItem: (item: KioskMenuItem, modifiers?: KioskModifier[]) => void;
  incrementLine: (lineKey: string) => void;
  decrementLine: (lineKey: string) => void;
  removeLine: (lineKey: string) => void;
  clearCart: () => void;
  replaceLines: (next: KioskCartLine[]) => void;
  setLastOrder: (order: KioskLastOrder | null) => void;
}

const Ctx = createContext<KioskCartState | null>(null);

export const KioskCartProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lines, setLines] = useState<KioskCartLine[]>([]);
  const [lastOrder, setLastOrder] = useState<KioskLastOrder | null>(null);

  const addItem = useCallback((item: KioskMenuItem, modifiers: KioskModifier[] = []) => {
    const lineKey = modifierKey(item.id, modifiers);
    const modifierTotal = modifiers.reduce((sum, m) => sum + Number(m.price_adjustment), 0);
    const linePrice = Math.round((Number(item.price) + modifierTotal) * 100) / 100;

    setLines((current) => {
      const existing = current.find((line) => line.line_key === lineKey);
      if (existing) {
        return current.map((line) =>
          line.line_key === lineKey
            ? { ...line, quantity: Math.min(20, line.quantity + 1) }
            : line,
        );
      }
      return [...current, {
        menu_item_id: item.id,
        name: item.name,
        price: linePrice,
        quantity: 1,
        modifiers,
        line_key: lineKey,
      }];
    });
  }, []);

  const incrementLine = useCallback((lineKey: string) => {
    setLines((current) => current.map((line) =>
      line.line_key === lineKey
        ? { ...line, quantity: Math.min(20, line.quantity + 1) }
        : line,
    ));
  }, []);

  const decrementLine = useCallback((lineKey: string) => {
    setLines((current) => current.flatMap((line) => {
      if (line.line_key !== lineKey) return [line];
      if (line.quantity <= 1) return [];
      return [{ ...line, quantity: line.quantity - 1 }];
    }));
  }, []);

  const removeLine = useCallback((lineKey: string) => {
    setLines((current) => current.filter((line) => line.line_key !== lineKey));
  }, []);

  const clearCart = useCallback(() => setLines([]), []);

  const replaceLines = useCallback((next: KioskCartLine[]) => {
    setLines(next.map((line) => {
      const modifiers = line.modifiers || [];
      return {
        menu_item_id: line.menu_item_id,
        name: line.name,
        price: Number(line.price),
        quantity: Math.max(1, Math.min(20, line.quantity)),
        modifiers,
        line_key: line.line_key || modifierKey(line.menu_item_id, modifiers),
      };
    }));
  }, []);

  const value = useMemo(() => {
    const count = lines.reduce((sum, line) => sum + line.quantity, 0);
    const total = Math.round(lines.reduce((sum, line) => sum + line.price * line.quantity, 0) * 100) / 100;
    return {
      lines,
      count,
      total,
      lastOrder,
      addItem,
      incrementLine,
      decrementLine,
      removeLine,
      clearCart,
      replaceLines,
      setLastOrder,
    };
  }, [addItem, clearCart, decrementLine, incrementLine, lastOrder, lines, removeLine, replaceLines]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useKioskCart = (): KioskCartState => {
  const value = useContext(Ctx);
  if (!value) throw new Error('useKioskCart must be used inside KioskCartProvider');
  return value;
};
