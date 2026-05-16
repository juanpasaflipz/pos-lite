import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, ShoppingCart } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKioskBinding } from '../context/KioskBindingContext';
import { useKioskCart } from '../context/KioskCartContext';
import { useIdleTimer } from '../hooks/useIdleTimer';
import { fetchMenu, type KioskMenuCategory, type KioskMenuItem } from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

const KioskMenuScreen: React.FC = () => {
  const navigate = useNavigate();
  const { tenantId, kioskToken } = useKioskBinding();
  const { addItem, count, total } = useKioskCart();
  const [categories, setCategories] = useState<KioskMenuCategory[]>([]);
  const [items, setItems] = useState<KioskMenuItem[]>([]);
  const [activeCategory, setActiveCategory] = useState<number | 'all'>('all');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useIdleTimer(() => navigate('/'), 60_000);

  useEffect(() => {
    if (!tenantId || !kioskToken) return;
    let alive = true;
    setLoading(true);
    fetchMenu({ tenantId, kioskToken })
      .then((data) => {
        if (!alive) return;
        const activeItems = data.items.filter((item) => item.active);
        const usedCategories = new Set(activeItems.map((item) => item.category_id));
        const visibleCategories = data.categories.filter((cat) => usedCategories.has(cat.id));
        setCategories(visibleCategories);
        setItems(activeItems);
        setActiveCategory(visibleCategories[0]?.id ?? 'all');
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
  }, [kioskToken, tenantId]);

  const visibleItems = useMemo(() => {
    if (activeCategory === 'all') return items;
    return items.filter((item) => item.category_id === activeCategory);
  }, [activeCategory, items]);

  return (
    <div className="h-full w-full bg-neutral-950 text-white flex flex-col">
      <header className="px-6 py-4 border-b border-neutral-800 flex items-center justify-between">
        <div>
          <p className="text-sm text-neutral-500 font-bold uppercase tracking-wider">Juanberto's</p>
          <h1 className="text-4xl font-black leading-none">Haz tu pedido</h1>
        </div>
        <button
          onClick={() => navigate('/')}
          className="h-16 px-5 rounded-lg bg-neutral-800 active:bg-neutral-700 text-lg font-bold touch-manipulation inline-flex items-center gap-2"
        >
          <ArrowLeft className="h-6 w-6" />
          Salir
        </button>
      </header>

      <main className="flex-1 min-h-0 flex flex-col">
        <nav className="border-b border-neutral-800 px-4 py-3 overflow-x-auto">
          <div className="flex gap-3 min-w-max">
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
          {!loading && !error && (
            <div className="grid grid-cols-2 gap-4 pb-4">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => addItem(item)}
                  className="min-h-[218px] rounded-lg bg-neutral-900 border border-neutral-800 active:border-brand-500 p-5 text-left touch-manipulation flex flex-col"
                >
                  <div className="flex-1">
                    <h2 className="text-[28px] font-black leading-[1.05] mb-3">{item.name}</h2>
                    {item.description && (
                      <p className="text-neutral-400 text-lg leading-snug line-clamp-3">{item.description}</p>
                    )}
                  </div>
                  <div className="flex items-center justify-between mt-5">
                    <span className="text-[28px] font-black text-brand-300">{money.format(Number(item.price))}</span>
                    <span className="h-14 w-14 rounded-lg bg-brand-600 flex items-center justify-center">
                      <Plus className="h-8 w-8" />
                    </span>
                  </div>
                </button>
              ))}
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
          <span className="text-right">{count} productos · {money.format(total)}</span>
        </button>
      </footer>
    </div>
  );
};

export default KioskMenuScreen;
