import React, { useCallback, useState } from 'react';
import { Check, Flame, Plus, RefreshCw, Sparkles, Store } from 'lucide-react';
import type {
  KioskSuggestions,
  RepeatOrderSuggestion,
  SuggestionItem,
} from '../lib/kioskApi';

const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

interface Props {
  suggestions: KioskSuggestions;
  firstName?: string | null;
  aiPowered: boolean;
  onPickItem: (s: SuggestionItem) => void;
  onPickRepeat: (r: RepeatOrderSuggestion) => void;
}

/** Image with a branded gradient fallback for imageless items. */
const Thumb: React.FC<{ url: string | null; name: string; className?: string }> = ({
  url,
  name,
  className = '',
}) => {
  if (url) {
    return <img src={url} alt={name} className={`object-cover ${className}`} />;
  }
  return (
    <div
      className={`bg-gradient-to-br from-brand-600 to-brand-900 flex items-center justify-center ${className}`}
    >
      <span className="text-5xl font-black text-white/80">
        {name.trim().charAt(0).toUpperCase() || '·'}
      </span>
    </div>
  );
};

const LaneHeading: React.FC<{
  icon: React.ReactNode;
  title: string;
  badge?: string;
}> = ({ icon, title, badge }) => (
  <div className="flex items-center gap-3 mb-3">
    <span className="text-brand-300">{icon}</span>
    <h2 className="text-2xl font-black">{title}</h2>
    {badge && (
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-900 text-brand-200 text-sm font-bold px-3 py-1">
        <Sparkles className="h-4 w-4" />
        {badge}
      </span>
    )}
  </div>
);

const SuggestionsPanel: React.FC<Props> = ({
  suggestions,
  firstName,
  aiPowered,
  onPickItem,
  onPickRepeat,
}) => {
  const [flash, setFlash] = useState<string | null>(null);

  const pulse = useCallback((key: string) => {
    setFlash(key);
    window.setTimeout(() => setFlash((c) => (c === key ? null : c)), 900);
  }, []);

  const { usual, for_you, house, popular } = suggestions;
  const hasAnything =
    !!usual || for_you.length > 0 || !!house || popular.length > 0;

  if (!hasAnything) {
    return (
      <div className="h-full flex items-center justify-center text-center text-neutral-500 text-xl px-8">
        Explora el menú y arma tu orden — toca cualquier platillo para agregarlo.
      </div>
    );
  }

  const card = (s: SuggestionItem, lane: string, accent: 'brand' | 'amber') => {
    const key = `${lane}-${s.menu_item_id}`;
    const added = flash === key;
    const ring = accent === 'amber' ? 'active:border-cockpit-yellow' : 'active:border-brand-500';
    return (
      <button
        key={key}
        onClick={() => {
          onPickItem(s);
          pulse(key);
        }}
        className={`relative w-[260px] shrink-0 rounded-xl bg-neutral-900 border border-neutral-800 ${ring} text-left touch-manipulation flex flex-col overflow-hidden`}
      >
        <Thumb url={s.image_url} name={s.name} className="h-32 w-full" />
        <div className="p-4 flex flex-col flex-1">
          <h3 className="text-xl font-black leading-tight line-clamp-2">{s.name}</h3>
          {s.reason && (
            <p
              className={`mt-2 text-sm font-semibold leading-snug line-clamp-2 ${
                accent === 'amber' ? 'text-cockpit-attention-text' : 'text-brand-200'
              }`}
            >
              {s.reason}
            </p>
          )}
          <div className="mt-auto pt-3 flex items-center justify-between">
            <span className="text-xl font-black text-brand-300">
              {money.format(Number(s.price))}
            </span>
            <span
              className={`h-11 w-11 rounded-lg flex items-center justify-center ${
                accent === 'amber' ? 'bg-cockpit-yellow text-neutral-950' : 'bg-brand-600 text-white'
              }`}
            >
              <Plus className="h-6 w-6" />
            </span>
          </div>
        </div>
        {added && (
          <div className="absolute inset-0 bg-cockpit-green/90 flex items-center justify-center gap-2 text-2xl font-black">
            <Check className="h-9 w-9" />
            Agregado
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-8 pb-6">
      {/* Repeat last order */}
      {usual && (
        <section>
          <LaneHeading icon={<RefreshCw className="h-7 w-7" />} title="Tu de siempre" />
          <button
            onClick={() => {
              onPickRepeat(usual);
              pulse('usual');
            }}
            className="relative w-full rounded-xl bg-neutral-900 border border-neutral-800 active:border-brand-500 p-5 text-left touch-manipulation flex items-center gap-5 overflow-hidden"
          >
            <div className="flex-1 min-w-0">
              <p className="text-brand-200 text-sm font-bold mb-1">{usual.reason}</p>
              <p className="text-xl font-black leading-tight line-clamp-2">
                {usual.items.map((i) => `${i.quantity}× ${i.name}`).join('  ·  ')}
              </p>
              <p className="text-neutral-400 text-base font-bold mt-1">
                {money.format(usual.total)}
              </p>
            </div>
            <span className="shrink-0 h-16 px-5 rounded-lg bg-brand-600 flex items-center gap-2 text-lg font-black">
              <Plus className="h-7 w-7" />
              Agregar
            </span>
            {flash === 'usual' && (
              <div className="absolute inset-0 bg-cockpit-green/90 flex items-center justify-center gap-2 text-2xl font-black">
                <Check className="h-9 w-9" />
                Agregado a tu orden
              </div>
            )}
          </button>
        </section>
      )}

      {/* Personalized picks */}
      {for_you.length > 0 && (
        <section>
          <LaneHeading
            icon={<Sparkles className="h-7 w-7" />}
            title={firstName ? `Para ti, ${firstName}` : 'Para ti'}
            badge={aiPowered ? 'Elegido con IA' : undefined}
          />
          <div className="flex gap-4 overflow-x-auto pb-2">
            {for_you.map((s) => card(s, 'for_you', 'brand'))}
          </div>
        </section>
      )}

      {/* Business-priority pick (customer-fit) */}
      {house && (
        <section>
          <LaneHeading icon={<Store className="h-7 w-7" />} title="Hoy en la casa" />
          <div className="flex gap-4 overflow-x-auto pb-2">
            {card(house, 'house', 'amber')}
          </div>
        </section>
      )}

      {/* Time-of-day popular — shown when there are no personalized picks */}
      {for_you.length === 0 && popular.length > 0 && (
        <section>
          <LaneHeading icon={<Flame className="h-7 w-7" />} title="Lo más pedido ahora" />
          <div className="flex gap-4 overflow-x-auto pb-2">
            {popular.map((s) => card(s, 'popular', 'brand'))}
          </div>
        </section>
      )}
    </div>
  );
};

export default SuggestionsPanel;
