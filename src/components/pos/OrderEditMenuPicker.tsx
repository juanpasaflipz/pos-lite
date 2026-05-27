import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, Loader2, Minus, Plus, X } from 'lucide-react';
import { getCategories, getMenuItems, getModifierGroupsForItem } from '../../api';
import type { MenuCategory, MenuItem, Modifier } from '../../types';
import { formatPrice } from '../../utils/currency';
import ModifierModal from '../ModifierModal';

export interface PickerLine {
  menu_item_id: number;
  item_name: string;
  unit_price: number;
  quantity: number;
  modifier_ids: number[];
  /** Pretty modifier preview for the cart-side display only. */
  modifier_names: string[];
  notes?: string;
  /** Stable key combining menu item + modifier set so identical picks stack. */
  line_key: string;
}

interface Props {
  onCancel: () => void;
  onConfirm: (lines: PickerLine[]) => void;
}

function lineKey(menuItemId: number, modifierIds: number[]): string {
  if (!modifierIds.length) return `m${menuItemId}`;
  return `m${menuItemId}:${[...modifierIds].sort((a, b) => a - b).join('_')}`;
}

/**
 * Slim menu picker for OrderEditModal's "Agregar producto" action. Reuses the
 * existing ModifierModal for items with required modifier groups. The working
 * set persists in this component's state until the user confirms; on confirm,
 * lines are returned to the parent which posts them via appendOrderItems.
 */
const OrderEditMenuPicker: React.FC<Props> = ({ onCancel, onConfirm }) => {
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [working, setWorking] = useState<PickerLine[]>([]);
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [cats, allItems] = await Promise.all([
          getCategories(true),
          getMenuItems(undefined, false),
        ]);
        if (!mounted) return;
        setCategories(cats);
        setItems(allItems);
        if (cats.length > 0) setSelectedCategoryId(cats[0].id);
      } catch (err) {
        if (mounted) setLoadError(err instanceof Error ? err.message : 'No se pudo cargar el menú');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const visibleItems = useMemo(() => {
    if (selectedCategoryId == null) return items;
    return items.filter((it) => it.category_id === selectedCategoryId);
  }, [items, selectedCategoryId]);

  const addOrIncrement = (
    menuItem: MenuItem,
    modifierIds: number[] = [],
    modifierObjects: Modifier[] = [],
    notes = '',
  ) => {
    const modifierTotal = modifierObjects.reduce((sum, m) => sum + Number(m.price_adjustment || 0), 0);
    const unitPrice = Math.round((Number(menuItem.price) + modifierTotal) * 100) / 100;
    const key = lineKey(menuItem.id, modifierIds);
    setWorking((current) => {
      const existing = current.find((l) => l.line_key === key);
      if (existing) {
        return current.map((l) =>
          l.line_key === key ? { ...l, quantity: Math.min(20, l.quantity + 1) } : l
        );
      }
      return [
        ...current,
        {
          menu_item_id: menuItem.id,
          item_name: menuItem.name,
          unit_price: unitPrice,
          quantity: 1,
          modifier_ids: modifierIds,
          modifier_names: modifierObjects.map((m) => m.name),
          notes: notes || undefined,
          line_key: key,
        },
      ];
    });
  };

  const handleItemTap = async (item: MenuItem) => {
    // Best-effort modifier check: if any required groups exist, open modal.
    // Otherwise add directly. Loading errors fall back to "no modifiers" so
    // common items still work even when the modifier endpoint hiccups.
    try {
      const groups = await getModifierGroupsForItem(item.id);
      const hasAny = (groups || []).length > 0;
      if (hasAny) {
        setModifierItem(item);
        return;
      }
    } catch {
      // proceed without modifiers
    }
    addOrIncrement(item);
  };

  const handleModifierConfirm = (modifierIds: number[], notes: string) => {
    if (!modifierItem) return;
    // Resolve modifier metadata from the loaded groups to enrich the cart row.
    // (ModifierModal returned only ids; we don't have the objects here, so we
    // fetch them again briefly via the same endpoint.)
    (async () => {
      try {
        const groups = await getModifierGroupsForItem(modifierItem.id);
        const pickedObjects: Modifier[] = [];
        for (const g of groups) {
          for (const m of g.modifiers || []) {
            if (modifierIds.includes(m.id)) pickedObjects.push(m);
          }
        }
        addOrIncrement(modifierItem, modifierIds, pickedObjects, notes);
      } catch {
        addOrIncrement(modifierItem, modifierIds, [], notes);
      } finally {
        setModifierItem(null);
      }
    })();
  };

  const adjust = (key: string, delta: number) => {
    setWorking((current) =>
      current.flatMap((l) => {
        if (l.line_key !== key) return [l];
        const next = l.quantity + delta;
        if (next <= 0) return [];
        return [{ ...l, quantity: Math.min(20, next) }];
      })
    );
  };

  const workingTotal = useMemo(
    () => working.reduce((sum, l) => sum + l.unit_price * l.quantity, 0),
    [working]
  );
  const workingCount = useMemo(
    () => working.reduce((sum, l) => sum + l.quantity, 0),
    [working]
  );

  return (
    <div className="fixed inset-0 bg-neutral-950 z-[65] flex flex-col">
      <header className="px-5 py-3 border-b border-neutral-800 flex items-center justify-between bg-neutral-900">
        <button
          onClick={onCancel}
          className="h-12 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-white font-bold inline-flex items-center gap-2"
        >
          <ChevronLeft className="w-5 h-5" />
          Atrás
        </button>
        <h2 className="text-xl font-black text-white">Agregar productos</h2>
        <button
          onClick={onCancel}
          className="h-12 w-12 rounded-lg bg-neutral-800 hover:bg-neutral-700 flex items-center justify-center"
          aria-label="Cerrar"
        >
          <X className="w-5 h-5 text-white" />
        </button>
      </header>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-10 h-10 text-brand-500 animate-spin" />
        </div>
      ) : loadError ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="text-cockpit-out-text font-bold">{loadError}</p>
          <button
            onClick={onCancel}
            className="h-12 px-6 rounded-lg bg-neutral-700 text-white font-bold"
          >
            Volver
          </button>
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-[180px_1fr_320px]">
          <aside className="border-r border-neutral-800 overflow-y-auto bg-neutral-900">
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategoryId(cat.id)}
                className={`w-full text-left px-4 py-3 border-b border-neutral-800 text-sm font-bold transition-colors ${
                  selectedCategoryId === cat.id
                    ? 'bg-brand-600 text-white'
                    : 'text-neutral-300 hover:bg-neutral-800'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </aside>

          <main className="overflow-y-auto p-4">
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleItemTap(item)}
                  className="rounded-lg bg-neutral-900 border border-neutral-800 hover:border-brand-500 active:bg-neutral-800 p-3 text-left transition-colors"
                >
                  <p className="text-base font-bold text-white truncate">{item.name}</p>
                  <p className="text-sm text-brand-300 font-bold mt-1">{formatPrice(Number(item.price))}</p>
                </button>
              ))}
              {visibleItems.length === 0 && (
                <p className="col-span-full text-center text-neutral-500 py-12 font-bold">
                  Sin productos en esta categoría
                </p>
              )}
            </div>
          </main>

          <aside className="border-l border-neutral-800 flex flex-col bg-neutral-900">
            <div className="px-4 py-3 border-b border-neutral-800">
              <p className="text-xs text-neutral-500 font-bold uppercase tracking-wider">A agregar</p>
              <p className="text-2xl font-black text-white">
                {workingCount} {workingCount === 1 ? 'producto' : 'productos'}
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {working.length === 0 ? (
                <p className="text-center text-neutral-500 py-8 text-sm font-bold">
                  Toca productos para agregarlos
                </p>
              ) : (
                working.map((l) => (
                  <div
                    key={l.line_key}
                    className="rounded-lg bg-neutral-950 border border-neutral-800 p-3"
                  >
                    <div className="flex justify-between items-baseline gap-2 mb-1">
                      <p className="text-sm font-bold text-white truncate flex-1">{l.item_name}</p>
                      <p className="text-sm font-bold text-brand-300 shrink-0">
                        {formatPrice(l.unit_price * l.quantity)}
                      </p>
                    </div>
                    {l.modifier_names.length > 0 && (
                      <p className="text-xs text-neutral-400 mb-2 truncate">
                        {l.modifier_names.join(' · ')}
                      </p>
                    )}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => adjust(l.line_key, -1)}
                        className="h-8 w-8 rounded-md bg-neutral-800 hover:bg-neutral-700 flex items-center justify-center"
                        aria-label="Menos"
                      >
                        <Minus className="w-4 h-4 text-white" />
                      </button>
                      <span className="h-8 w-10 flex items-center justify-center font-bold text-white">
                        {l.quantity}
                      </span>
                      <button
                        onClick={() => adjust(l.line_key, 1)}
                        className="h-8 w-8 rounded-md bg-neutral-800 hover:bg-neutral-700 flex items-center justify-center"
                        aria-label="Más"
                      >
                        <Plus className="w-4 h-4 text-white" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-neutral-800 p-3 space-y-2">
              <div className="flex justify-between items-baseline">
                <span className="text-sm text-neutral-400 font-bold">Subtotal</span>
                <span className="text-xl font-black text-white">{formatPrice(workingTotal)}</span>
              </div>
              <button
                onClick={() => onConfirm(working)}
                disabled={working.length === 0}
                className="w-full h-14 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-black inline-flex items-center justify-center gap-2 transition-colors"
              >
                <Check className="w-5 h-5" />
                Confirmar
              </button>
            </div>
          </aside>
        </div>
      )}

      {modifierItem && (
        <ModifierModal
          item={modifierItem}
          onConfirm={handleModifierConfirm}
          onClose={() => setModifierItem(null)}
        />
      )}
    </div>
  );
};

export default OrderEditMenuPicker;
