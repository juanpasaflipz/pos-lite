import React, { useEffect, useMemo, useState } from 'react';
import { getMenuBoardData } from '../api';
import type { MenuBoardDataResponse } from '../types/menu-board';
import { formatPrice } from '../utils/currency';

const REFRESH_MS = 60_000;

function useRotation(itemsLength: number, rotationSeconds: number) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
  }, [itemsLength]);

  useEffect(() => {
    if (itemsLength <= 1) return;
    const delay = Math.max(rotationSeconds, 10) * 1000;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % itemsLength);
    }, delay);
    return () => window.clearInterval(timer);
  }, [itemsLength, rotationSeconds]);

  return index;
}

function MenuSection({
  title,
  items,
  showPrices,
  compact = false,
}: {
  title: string;
  items: Array<{ id: number; name: string; price: number; description?: string; sold_out?: boolean }>;
  showPrices: boolean;
  compact?: boolean;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between border-b border-stone-300/80 pb-2">
        <h2 className={`${compact ? 'text-[1.35rem]' : 'text-[1.8rem]'} font-semibold tracking-tight text-stone-900`}>
          {title}
        </h2>
        <span className="text-[0.72rem] uppercase tracking-[0.22em] text-stone-500">
          Hecho al momento
        </span>
      </div>

      <div className="space-y-3">
        {items.map((item) => (
          <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
            <div className="min-w-0">
              <div className={`truncate text-[1.08rem] font-medium ${
                item.sold_out ? 'text-stone-400 line-through' : 'text-stone-900'
              }`}>
                {item.name}
              </div>
              {item.description ? (
                <div className="mt-0.5 line-clamp-2 text-[0.78rem] leading-5 text-stone-500">
                  {item.description}
                </div>
              ) : null}
            </div>
            {showPrices ? (
              <div className={`whitespace-nowrap text-[1rem] font-semibold tabular-nums ${
                item.sold_out ? 'text-stone-400 line-through' : 'text-stone-800'
              }`}>
                {formatPrice(item.price)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function MenuBoardScreen() {
  const [data, setData] = useState<MenuBoardDataResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const next = await getMenuBoardData();
        if (cancelled) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load menu board');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Single platform brand (cockpit-system / enamel blue) — per-tenant color overrides were removed.
  const accentColor = '#2E5EAA';
  const mainCategory = data?.categories[0] || null;
  const secondaryCategories = data?.categories.slice(1) || [];
  const rotationIndex = useRotation(data?.atmosphere.assets.length || 0, data?.layout.rotationSeconds || 30);
  const activeAsset = data?.atmosphere.assets[rotationIndex] || null;
  const dateLabel = useMemo(
    () => new Date().toLocaleDateString('es-MX', { weekday: 'long', month: 'long', day: 'numeric' }),
    []
  );

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-stone-100 text-stone-700">Cargando menu...</div>;
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-100 px-8 text-center text-stone-700">
        <div className="max-w-md space-y-3">
          <h1 className="text-2xl font-semibold text-stone-900">Menu no disponible</h1>
          <p>{error || 'No se pudo cargar el menu.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen bg-[#f4efe6] text-stone-900"
      style={{
        backgroundImage: 'radial-gradient(circle at top left, rgba(255,255,255,0.85), rgba(244,239,230,0.96) 38%, rgba(236,229,216,1) 100%)',
      }}
    >
      <div className="mx-auto grid min-h-screen max-w-[1720px] grid-cols-[1.72fr_0.88fr] gap-10 px-10 py-8">
        <div className="flex min-h-0 flex-col rounded-[2rem] border border-stone-300/80 bg-white/70 p-8 shadow-[0_18px_80px_rgba(80,54,24,0.08)] backdrop-blur">
          <header className="mb-8 flex items-start justify-between gap-6 border-b border-stone-300/80 pb-6">
            <div className="space-y-2">
              <div className="text-[0.72rem] uppercase tracking-[0.28em] text-stone-500">
                {dateLabel}
              </div>
              <h1 className="text-5xl font-semibold tracking-tight text-stone-950">
                {data.shop.name}
              </h1>
              {data.layout.showTagline && data.shop.tagline ? (
                <p className="max-w-2xl text-[1.08rem] leading-7 text-stone-600">
                  {data.shop.tagline}
                </p>
              ) : null}
            </div>

            {data.layout.showLogo && data.shop.logoUrl ? (
              <div className="shrink-0 rounded-[1.5rem] border border-stone-300/80 bg-white px-5 py-4">
                <img src={data.shop.logoUrl} alt={data.shop.name} className="h-16 w-auto object-contain" />
              </div>
            ) : (
              <div className="shrink-0 text-right">
                <div className="text-[0.72rem] uppercase tracking-[0.24em] text-stone-500">Desde hoy</div>
                <div className="mt-2 text-sm text-stone-600">{data.shop.address || 'Hecho en el barrio'}</div>
              </div>
            )}
          </header>

          <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] gap-8">
            {mainCategory ? (
              <MenuSection
                title={mainCategory.name}
                items={mainCategory.items}
                showPrices={data.layout.showPrices}
              />
            ) : null}

            <div className={`grid gap-8 ${secondaryCategories.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {secondaryCategories.map((category) => (
                <MenuSection
                  key={category.id}
                  title={category.name}
                  items={category.items}
                  showPrices={data.layout.showPrices}
                  compact
                />
              ))}
            </div>
          </div>

          <footer className="mt-8 flex items-center justify-between border-t border-stone-300/80 pt-5 text-sm text-stone-500">
            <span>{data.layout.footerText || 'Precios en MXN'}</span>
            <span style={{ color: accentColor }}>{data.shop.address || 'Tu tienda de la colonia'}</span>
          </footer>
        </div>

        <aside className="flex min-h-0 flex-col gap-5">
          <div className="relative min-h-[66vh] overflow-hidden rounded-[2rem] border border-stone-300/80 bg-stone-900 shadow-[0_18px_80px_rgba(80,54,24,0.16)]">
            {activeAsset?.imageUrl ? (
              <>
                <img
                  key={activeAsset.id}
                  src={activeAsset.imageUrl}
                  alt={activeAsset.title || data.shop.name}
                  className="absolute inset-0 h-full w-full object-cover transition-opacity duration-700"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-stone-950/85 via-stone-900/20 to-stone-900/10" />
              </>
            ) : (
              <div className="absolute inset-0 bg-[linear-gradient(135deg,#2b241d,#4b4138,#6a5b4c)]" />
            )}

            <div className="relative flex h-full flex-col justify-end p-7 text-stone-100">
              <div className="mb-3 inline-flex w-fit rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[0.7rem] uppercase tracking-[0.22em] text-stone-200">
                Local y de casa
              </div>
              <h2 className="max-w-sm text-3xl font-semibold tracking-tight">
                {activeAsset?.title || data.shop.name}
              </h2>
              <p className="mt-3 max-w-sm text-[1rem] leading-7 text-stone-200/90">
                {activeAsset?.body || 'Sabor honesto, ingredientes directos y una carta hecha para el dia a dia del barrio.'}
              </p>
            </div>
          </div>

          <div className="rounded-[2rem] border border-stone-300/80 bg-white/75 p-6 shadow-[0_18px_60px_rgba(80,54,24,0.08)]">
            <div className="text-[0.72rem] uppercase tracking-[0.24em] text-stone-500">Hoy / temporada</div>
            <div className="mt-3 text-2xl font-semibold tracking-tight text-stone-900">
              {data.atmosphere.seasonalCallout?.title || 'Especial de la casa'}
            </div>
            <p className="mt-3 text-[1rem] leading-7 text-stone-600">
              {data.atmosphere.seasonalCallout?.body || 'Actualiza este bloque con una salsa, bebida o nota de temporada sin mover el resto del menu.'}
            </p>
          </div>

          <div className="rounded-[2rem] border border-stone-300/80 bg-white/75 px-6 py-5 shadow-[0_18px_60px_rgba(80,54,24,0.08)]">
            <div className="text-[0.72rem] uppercase tracking-[0.24em] text-stone-500">La casa</div>
            <div className="mt-2 flex items-center justify-between gap-4">
              <div>
                <div className="text-lg font-medium text-stone-900">Menu fijo, trato cercano</div>
                <div className="text-sm text-stone-600">Sin promos gritadas, sin pantallas invasivas.</div>
              </div>
              <div className="h-12 w-12 rounded-full border border-stone-300 bg-stone-100" style={{ backgroundColor: `${accentColor}1a`, borderColor: `${accentColor}33` }} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
