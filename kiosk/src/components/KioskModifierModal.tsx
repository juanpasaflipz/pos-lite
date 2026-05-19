import React, { useMemo, useState } from 'react';
import { X, Plus, Check } from 'lucide-react';
import type { KioskMenuItem, KioskModifier, KioskModifierGroup } from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

interface Props {
  item: KioskMenuItem;
  groups: KioskModifierGroup[];
  onCancel: () => void;
  onConfirm: (modifiers: KioskModifier[]) => void;
}

type SelectionMap = Record<number, Set<number>>; // groupId -> set of modifier ids

function isValid(groups: KioskModifierGroup[], selection: SelectionMap): boolean {
  for (const group of groups) {
    const picked = selection[group.id] || new Set<number>();
    if (group.required && picked.size === 0) return false;
    if (picked.size < group.min_selections) return false;
    if (group.max_selections > 0 && picked.size > group.max_selections) return false;
  }
  return true;
}

const KioskModifierModal: React.FC<Props> = ({ item, groups, onCancel, onConfirm }) => {
  const [selection, setSelection] = useState<SelectionMap>(() => {
    const initial: SelectionMap = {};
    for (const group of groups) initial[group.id] = new Set();
    return initial;
  });

  const togglePick = (group: KioskModifierGroup, modifierId: number) => {
    setSelection((prev) => {
      const next: SelectionMap = { ...prev };
      const current = new Set(prev[group.id] || []);
      if (group.selection_type === 'single') {
        if (current.has(modifierId)) {
          current.clear();
        } else {
          current.clear();
          current.add(modifierId);
        }
      } else {
        if (current.has(modifierId)) {
          current.delete(modifierId);
        } else if (group.max_selections === 0 || current.size < group.max_selections) {
          current.add(modifierId);
        }
      }
      next[group.id] = current;
      return next;
    });
  };

  const flatPicks: KioskModifier[] = useMemo(() => {
    const picks: KioskModifier[] = [];
    for (const group of groups) {
      const ids = selection[group.id] || new Set<number>();
      for (const mod of group.modifiers) {
        if (ids.has(mod.id)) picks.push(mod);
      }
    }
    return picks;
  }, [groups, selection]);

  const modifierTotal = flatPicks.reduce((sum, m) => sum + Number(m.price_adjustment), 0);
  const total = Math.round((Number(item.price) + modifierTotal) * 100) / 100;
  const canConfirm = isValid(groups, selection);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6">
      <div className="bg-neutral-900 border border-neutral-800 rounded-3xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between p-6 border-b border-neutral-800 gap-4">
          <div className="min-w-0">
            <h2 className="text-3xl font-black leading-tight">{item.name}</h2>
            {item.description && (
              <p className="text-base text-neutral-400 font-bold mt-1 line-clamp-2">{item.description}</p>
            )}
          </div>
          <button
            onClick={onCancel}
            aria-label="Cerrar"
            className="h-14 w-14 rounded-full bg-neutral-800 active:bg-neutral-700 flex items-center justify-center shrink-0"
          >
            <X className="h-7 w-7" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {groups.map((group) => {
            const picked = selection[group.id] || new Set<number>();
            const max = group.max_selections;
            return (
              <section key={group.id}>
                <header className="mb-3 flex items-baseline justify-between gap-3">
                  <h3 className="text-2xl font-black">{group.name}</h3>
                  <p className="text-sm font-bold text-neutral-400 shrink-0">
                    {group.required ? 'Requerido' : 'Opcional'}
                    {group.selection_type === 'multiple' && max > 0 && ` · hasta ${max}`}
                  </p>
                </header>
                <div className="grid grid-cols-2 gap-3">
                  {group.modifiers.map((mod) => {
                    const isOn = picked.has(mod.id);
                    return (
                      <button
                        key={mod.id}
                        onClick={() => togglePick(group, mod.id)}
                        className={`min-h-[64px] rounded-2xl border-2 px-5 py-3 text-left flex items-center justify-between gap-3 touch-manipulation ${
                          isOn
                            ? 'border-brand-500 bg-brand-600/15'
                            : 'border-neutral-800 bg-neutral-800/40 active:bg-neutral-800'
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="text-lg font-black leading-tight">{mod.name}</p>
                          {Number(mod.price_adjustment) !== 0 && (
                            <p className={`text-sm font-bold ${isOn ? 'text-brand-300' : 'text-neutral-400'}`}>
                              {Number(mod.price_adjustment) > 0 ? '+' : ''}
                              {money.format(Number(mod.price_adjustment))}
                            </p>
                          )}
                        </div>
                        <span
                          className={`h-9 w-9 rounded-full border-2 flex items-center justify-center shrink-0 ${
                            isOn ? 'border-brand-500 bg-brand-500 text-neutral-950' : 'border-neutral-700'
                          }`}
                        >
                          {isOn && <Check className="h-5 w-5" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>

        <div className="p-6 border-t border-neutral-800 grid grid-cols-[1fr_auto] gap-4">
          <button
            onClick={onCancel}
            className="h-16 rounded-2xl bg-neutral-800 active:bg-neutral-700 text-lg font-black touch-manipulation"
          >
            Cancelar
          </button>
          <button
            onClick={() => canConfirm && onConfirm(flatPicks)}
            disabled={!canConfirm}
            className="h-16 px-8 rounded-2xl bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-600 text-lg font-black touch-manipulation inline-flex items-center gap-3 justify-center"
          >
            <Plus className="h-6 w-6" />
            Agregar · {money.format(total)}
          </button>
        </div>
      </div>
    </div>
  );
};

export default KioskModifierModal;
