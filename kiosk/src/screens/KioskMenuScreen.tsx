import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Gift, Plus, ShoppingCart, Sparkles, UtensilsCrossed } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useKioskCustomer } from '../context/KioskCustomerContext';
import { useKioskSuggestions } from '../context/KioskSuggestionsContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import {
  fetchMenu,
  logSuggestionEvents,
  type KioskMenuCategory,
  type KioskMenuItem,
  type KioskModifier,
  type KioskSuggestions,
  type RepeatOrderSuggestion,
  type StampStatus,
  type SuggestionItem,
} from '../lib/kioskApi';
import KioskModifierModal from '../components/KioskModifierModal';
import SuggestionsPanel from '../components/SuggestionsPanel';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

// Virtual category id for the personalized suggestions tab.
const SUGGEST_TAB = -1;

const StampBar: React.FC<{ stamp: StampStatus }> = ({ stamp }) => {
  if (stamp.completed) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-amber-500 text-neutral-950 px-3 py-1 text-sm font-black">
        <Gift className="h-4 w-4" />
        ¡Tienes un premio!
      </span>
    );
  }
  const required = Math.max(0, stamp.required || 0);
  return (
    <span className="inline-flex items-center gap-2">
      <span className="flex gap-1">
        {Array.from({ length: required }).map((_, i) => (
          <span
            key={i}
            className={`h-2.5 w-2.5 rounded-full ${
              i < stamp.earned ? 'bg-brand-400' : 'bg-neutral-700'
            }`}
          />
        ))}
      </span>
      <span className="text-sm font-bold text-neutral-400">
        {stamp.earned}/{stamp.required} sellos
      </span>
    </span>
  );
};

const KioskMenuScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantId, kioskToken } = useKioskBinding();
  const { addItem, count, total } = useKioskCart();
  const { session } = useKioskCustomer();
  const { modifierMap, anonPopular } = useKioskSuggestions();
  const [categories, setCategories] = useState<KioskMenuCategory[]>([]);
  const [items, setItems] = useState<KioskMenuItem[]>([]);
  const [activeCategory, setActiveCategory] = useState<number | 'all'>(SUGGEST_TAB);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modifierItem, setModifierItem] = useState<KioskMenuItem | null>(null);
  useIdleTimer(() => navigate('/'), 60_000);

  const auth = useMemo(
    () => (tenantId && kioskToken ? { tenantId, kioskToken } : null),
    [tenantId, kioskToken],
  );

  useEffect(() => {
    if (!auth) return;
    let alive = true;
    setLoading(true);
    fetchMenu(auth)
      .then((data) => {
        if (!alive) return;
        const activeItems = data.items.filter((item) => item.active);
        const usedCategories = new Set(activeItems.map((item) => item.category_id));
        setCategories(data.categories.filter((cat) => usedCategories.has(cat.id)));
        setItems(activeItems);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(err.message || 'No se pudo cargar el menu');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [auth]);

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const suggestions: KioskSuggestions = useMemo(
    () =>
      session
        ? session.suggestions
        : { usual: null, for_you: [], house: null, popular: anonPopular },
    [session, anonPopular],
  );

  const visibleItems = useMemo(() => {
    if (activeCategory === 'all' || activeCategory === SUGGEST_TAB) return items;
    return items.filter((item) => item.category_id === activeCategory);
  }, [activeCategory, items]);

  const handleItemTap = (item: KioskMenuItem) => {
    const groups = modifierMap[item.id];
    if (groups && groups.length) {
      setModifierItem(item);
    } else {
      addItem(item);
    }
  };

  const confirmModifierAdd = (modifiers: KioskModifier[]) => {
    if (!modifierItem) return;
    addItem(modifierItem, modifiers);
    setModifierItem(null);
  };

  const handlePickItem = (s: SuggestionItem) => {
    const item = itemsById.get(s.menu_item_id);
    if (auth) {
      logSuggestionEvents(auth, session?.customerToken ?? null, [
        {
          menu_item_id: s.menu_item_id,
          lane: s.lane,
          source: s.source,
          event_type: 'tapped',
          reason: s.reason,
        },
      ]);
    }
    if (!item) return;
    const groups = modifierMap[item.id];
    if (groups && groups.length) {
      setModifierItem(item);
    } else {
      addItem(item);
    }
  };

  const handlePickRepeat = (r: RepeatOrderSuggestion) => {
    for (const line of r.items) {
      const item = itemsById.get(line.menu_item_id);
      if (!item) continue;
      for (let n = 0; n < line.quantity; n += 1) addItem(item);
    }
    if (auth) {
      logSuggestionEvents(auth, session?.customerToken ?? null, [
        { lane: 'usual', source: 'deterministic', event_type: 'tapped' },
      ]);
    }
  };

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between gap-4">
        <div className="min-w-0">
          {session ? (
            <>
              <h1 className="text-4xl font-black leading-none truncate">
                Hola, {session.firstName} 👋
              </h1>
              <div className="mt-2">
                {session.stamp ? (
                  <StampBar stamp={session.stamp} />
                ) : (
                  <p className="text-sm text-neutral-500 font-bold">Haz tu pedido</p>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-neutral-500 font-bold uppercase tracking-wider">
                Bienvenido
              </p>
              <h1 className="text-4xl font-black leading-none">Haz tu pedido</h1>
            </>
          )}
        </div>
        <button
          onClick={() => navigate('/')}
          className="h-16 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-lg font-bold touch-manipulation inline-flex items-center gap-2 shrink-0"
        >
          <ArrowLeft className="h-6 w-6" />
          Salir
        </button>
      </header>

      <main className="flex-1 min-h-0 flex flex-col">
        <nav className="border-b border-neutral-800 px-4 py-3 overflow-x-auto">
          <div className="flex gap-3 min-w-max">
            <button
              onClick={() => setActiveCategory(SUGGEST_TAB)}
              className={`h-16 px-6 rounded-lg text-xl font-black touch-manipulation whitespace-nowrap inline-flex items-center gap-2 ${
                activeCategory === SUGGEST_TAB
                  ? 'bg-brand-600 text-white'
                  : 'bg-neutral-900 text-neutral-200 active:bg-neutral-800'
              }`}
            >
              <Sparkles className="h-5 w-5" />
              {session ? 'Para ti' : 'Popular'}
            </button>
            {categories.map((category) => (
              <button
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={`h-16 px-6 rounded-lg text-xl font-black touch-manipulation whitespace-nowrap ${
                  activeCategory === category.id
                    ? 'bg-brand-600 text-white'
                    : 'bg-neutral-900 text-neutral-200 active:bg-neutral-800'
                }`}
              >
                {category.name}
              </button>
            ))}
          </div>
        </nav>

        <section className="flex-1 min-h-0 p-5 overflow-y-auto">
          {loading && (
            <div className="h-full flex items-center justify-center text-2xl text-neutral-400">
              Cargando menu...
            </div>
          )}
          {error && (
            <div className="h-full flex items-center justify-center text-2xl text-red-300">
              {error}
            </div>
          )}
          {!loading && !error && activeCategory === SUGGEST_TAB && (
            <SuggestionsPanel
              suggestions={suggestions}
              firstName={session?.firstName}
              aiPowered={!!session?.aiPowered}
              onPickItem={handlePickItem}
              onPickRepeat={handlePickRepeat}
            />
          )}
          {!loading && !error && activeCategory !== SUGGEST_TAB && (
            <div className="grid grid-cols-3 gap-4 pb-4">
              {visibleItems.map((item) => {
                const hasModifiers = !!(modifierMap[item.id] && modifierMap[item.id].length);
                return (
                <button
                  key={item.id}
                  onClick={() => handleItemTap(item)}
                  className="rounded-lg bg-neutral-900 border border-neutral-800 active:border-brand-500 text-left touch-manipulation flex flex-col overflow-hidden"
                >
                  <div className="aspect-[4/3] w-full bg-gradient-to-br from-neutral-800 to-neutral-900 flex items-center justify-center overflow-hidden">
                    {item.image_url ? (
                      <img
                        src={item.image_url}
                        alt={item.name}
                        loading="lazy"
                        className="h-full w-full object-cover"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <UtensilsCrossed className="h-12 w-12 text-neutral-600" />
                    )}
                  </div>
                  <div className="p-4 flex-1 flex flex-col">
                    <div className="flex-1">
                      <h2 className="text-xl font-black leading-tight mb-1">{item.name}</h2>
                      {item.description && (
                        <p className="text-neutral-400 text-sm leading-snug line-clamp-2">
                          {item.description}
                        </p>
                      )}
                      {hasModifiers && (
                        <p className="text-xs font-bold text-brand-300 mt-1">Personaliza tu orden</p>
                      )}
                    </div>
                    <div className="flex items-center justify-between mt-3">
                      <span className="text-2xl font-black text-brand-300">
                        {money.format(Number(item.price))}
                      </span>
                      <span className="h-11 w-11 rounded-lg bg-brand-600 flex items-center justify-center">
                        <Plus className="h-6 w-6" />
                      </span>
                    </div>
                  </div>
                </button>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <footer className="p-4 border-t border-neutral-800 bg-neutral-950">
        <button
          disabled={count === 0}
          onClick={() => navigate('/cart')}
          className="w-full min-h-20 bg-brand-600 active:bg-brand-700 disabled:bg-neutral-800 disabled:text-neutral-500 rounded-lg py-4 px-6 text-2xl font-black touch-manipulation flex items-center justify-between gap-4"
        >
          <span className="inline-flex items-center gap-3">
            <ShoppingCart className="h-8 w-8" />
            Tu orden
          </span>
          <span className="text-right">
            {count} productos · {money.format(total)}
          </span>
        </button>
      </footer>

      {modifierItem && (
        <KioskModifierModal
          item={modifierItem}
          groups={modifierMap[modifierItem.id] || []}
          onCancel={() => setModifierItem(null)}
          onConfirm={confirmModifierAdd}
        />
      )}
    </div>
  );
};

export default KioskMenuScreen;
