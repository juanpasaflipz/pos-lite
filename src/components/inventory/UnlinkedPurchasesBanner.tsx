import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link2Off, ChevronRight } from 'lucide-react';
import { UnlinkedExpense } from '../../api';

interface Props {
  expenses: UnlinkedExpense[];
  loading: boolean;
  onOpen: () => void;
}

export default function UnlinkedPurchasesBanner({ expenses, loading, onOpen }: Props) {
  const { t } = useTranslation('inventory');

  if (loading || expenses.length === 0) return null;

  const totalAmount = expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0);

  return (
    <button
      onClick={onOpen}
      className="w-full mb-4 flex items-center gap-4 p-4 bg-cockpit-yellow/10 border border-cockpit-yellow/50 hover:bg-cockpit-yellow/20 rounded-lg transition-colors text-left"
    >
      <div className="p-2 bg-cockpit-yellow/20 rounded-lg flex-shrink-0">
        <Link2Off className="text-cockpit-attention-text" size={22} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-white text-sm">
          {t('unlinked.bannerTitle', { count: expenses.length })}
        </div>
        <div className="text-xs text-neutral-400 mt-0.5">
          {t('unlinked.bannerSubtitle', { amount: totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}
        </div>
      </div>
      <span className="px-3 py-1.5 bg-cockpit-yellow text-neutral-950 rounded-md text-xs font-semibold flex items-center gap-1">
        {t('unlinked.review')}
        <ChevronRight size={14} />
      </span>
    </button>
  );
}
