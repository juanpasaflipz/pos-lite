import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShoppingCart, Send } from 'lucide-react';
import { useMobileCart } from '../../context/MobileCartContext';
import { formatPrice } from '../../utils/currency';
import { tapFeedback } from '../../lib/haptics';

interface Props {
  onSendToKitchen: () => void;
}

const MobileCartBar: React.FC<Props> = ({ onSendToKitchen }) => {
  const { itemCount, total, quickMode } = useMobileCart();
  const navigate = useNavigate();
  const { t } = useTranslation('pos');

  if (itemCount === 0) return null;

  const handleTap = () => {
    tapFeedback();
    if (quickMode) {
      onSendToKitchen();
    } else {
      navigate('/m/cart');
    }
  };

  return (
    <div className="fixed left-0 right-0 bottom-16 z-30 px-3 pb-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 4.5rem)' }}>
      <button
        onClick={handleTap}
        className={`w-full flex items-center justify-between rounded-2xl px-5 py-3.5 shadow-lg touch-manipulation ${
          quickMode
            ? 'bg-green-600 active:bg-green-700'
            : 'bg-brand-600 active:bg-brand-700'
        } text-white font-semibold text-base`}
      >
        <div className="flex items-center gap-2">
          {quickMode ? <Send className="w-5 h-5" /> : <ShoppingCart className="w-5 h-5" />}
          <span>
            {quickMode ? t('mobilePOS.sendToKitchen') : t('mobilePOS.viewCart')}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="bg-white/20 rounded-full px-2.5 py-0.5 text-sm">
            {itemCount}
          </span>
          <span>{formatPrice(total)}</span>
        </div>
      </button>
    </div>
  );
};

export default React.memo(MobileCartBar);
