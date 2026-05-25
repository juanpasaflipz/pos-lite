import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Trash2, PauseCircle } from 'lucide-react';
import { ParkedCart } from '../../lib/offlineDb';
import { formatPrice } from '../../utils/currency';
import { formatTime } from '../../utils/dateFormat';

interface ParkedCartsModalProps {
  parkedCarts: ParkedCart[];
  hasCartItems: boolean;
  onClose: () => void;
  onParkCurrent: (name: string) => void;
  onResume: (id: number) => void;
  onDelete: (id: number) => void;
}

function cartTotal(items: ParkedCart['items']): number {
  return items.reduce((sum, it) => sum + it.unit_price * it.quantity, 0);
}

export default function ParkedCartsModal({
  parkedCarts,
  hasCartItems,
  onClose,
  onParkCurrent,
  onResume,
  onDelete,
}: ParkedCartsModalProps) {
  const { t } = useTranslation('pos');
  const [showParkInput, setShowParkInput] = useState(false);
  const [parkName, setParkName] = useState('');

  const handlePark = () => {
    const name = parkName.trim() || t('parkedCarts.defaultName', { time: formatTime(new Date()) });
    onParkCurrent(name);
    setParkName('');
    setShowParkInput(false);
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] border border-neutral-800 flex flex-col">
        <div className="bg-cockpit-blue text-white p-6 rounded-t-2xl flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">{t('parkedCarts.title')}</h2>
            <p className="text-cockpit-system-text text-sm">{t('parkedCarts.subtitle')}</p>
          </div>
          <button onClick={onClose} className="text-cockpit-system-text hover:text-white">
            <X className="w-6 h-6" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {parkedCarts.length === 0 ? (
            <p className="text-neutral-500 text-center py-8">{t('parkedCarts.empty')}</p>
          ) : (
            parkedCarts.map((parked) => (
              <div
                key={parked.id}
                className="bg-neutral-800 border border-neutral-700 rounded-lg p-4 flex items-center justify-between gap-3"
              >
                <button
                  onClick={() => parked.id != null && onResume(parked.id)}
                  className="flex-1 text-left hover:opacity-80 transition-opacity"
                >
                  <p className="font-bold text-white">{parked.name}</p>
                  <p className="text-neutral-400 text-sm mt-1">
                    {t('parkedCarts.itemCount', { count: parked.items.length })} · {formatPrice(cartTotal(parked.items))}
                  </p>
                  <p className="text-neutral-500 text-xs mt-1">{formatTime(new Date(parked.parkedAt))}</p>
                </button>
                <button
                  onClick={() => parked.id != null && onDelete(parked.id)}
                  className="p-2 text-neutral-500 hover:text-brand-400 hover:bg-neutral-700 rounded-lg transition-colors"
                  title={t('parkedCarts.delete')}
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            ))
          )}
        </div>
        {hasCartItems && (
          <div className="border-t border-neutral-800 p-4">
            {showParkInput ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={parkName}
                  onChange={(e) => setParkName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handlePark();
                    if (e.key === 'Escape') {
                      setShowParkInput(false);
                      setParkName('');
                    }
                  }}
                  placeholder={t('parkedCarts.namePlaceholder')}
                  className="w-full px-4 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-cockpit-blue"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowParkInput(false);
                      setParkName('');
                    }}
                    className="flex-1 py-2 bg-neutral-700 text-white font-semibold rounded-lg hover:bg-neutral-600"
                  >
                    {t('common:buttons.cancel')}
                  </button>
                  <button
                    onClick={handlePark}
                    className="flex-1 py-2 bg-cockpit-blue text-white font-semibold rounded-lg hover:bg-cockpit-blue/90"
                  >
                    {t('parkedCarts.park')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowParkInput(true)}
                className="w-full py-3 bg-cockpit-blue text-white font-bold rounded-lg hover:bg-cockpit-blue/90 flex items-center justify-center gap-2 transition-all"
              >
                <PauseCircle className="w-5 h-5" />
                {t('parkedCarts.parkCurrent')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
