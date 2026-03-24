import React from 'react';
import { ShoppingBag } from 'lucide-react';
import { formatPrice } from '../utils/currency';

interface MiniCartButtonProps {
  count: number;
  total: number;
  onClick: () => void;
}

const MiniCartButton: React.FC<MiniCartButtonProps> = ({ count, total, onClick }) => {
  if (count === 0) return null;

  return (
    <button
      onClick={onClick}
      className="fixed bottom-6 right-6 z-30 bg-brand-600 text-white rounded-full px-5 py-3 shadow-xl flex items-center gap-3 active:scale-95 transition-transform touch-manipulation"
    >
      <div className="relative">
        <ShoppingBag className="w-5 h-5" />
        <span className="absolute -top-2 -right-2 bg-white text-brand-600 text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
          {count}
        </span>
      </div>
      <span className="font-bold text-base">{formatPrice(total)}</span>
    </button>
  );
};

export default MiniCartButton;
