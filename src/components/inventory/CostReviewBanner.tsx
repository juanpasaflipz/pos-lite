import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronRight } from 'lucide-react';

interface Props {
  count: number;
  onOpen: () => void;
}

export default function CostReviewBanner({ count, onOpen }: Props) {
  const { t } = useTranslation('inventory');
  if (count <= 0) return null;
  return (
    <button
      onClick={onOpen}
      className="w-full mb-4 flex items-center gap-4 p-4 bg-red-500/10 border border-red-500/40 hover:bg-red-500/20 rounded-lg transition-colors text-left"
    >
      <div className="p-2 bg-red-500/20 rounded-lg flex-shrink-0">
        <AlertTriangle className="text-red-400" size={22} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-white text-sm">
          {t('costReview.bannerTitle', {
            defaultValue:
              '{{count}} costo(s) por revisar — posible error de unidad',
            count,
          })}
        </div>
        <div className="text-xs text-neutral-400 mt-0.5">
          {t(
            'costReview.bannerSubtitle',
            'Estos precios parecen ser el total pagado, no el precio por unidad. Afectan recetas y márgenes.'
          )}
        </div>
      </div>
      <span className="px-3 py-1.5 bg-red-500 text-white rounded-md text-xs font-semibold flex items-center gap-1">
        {t('costReview.review', 'Revisar')}
        <ChevronRight size={14} />
      </span>
    </button>
  );
}
