import React from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  selected: number | null;
  onSelect: (percent: number | null) => void;
}

const TIP_OPTIONS: Array<{ percent: number | null; label: string }> = [
  { percent: null, label: 'tipNone' },
  { percent: 10, label: '10%' },
  { percent: 15, label: '15%' },
  { percent: 20, label: '20%' },
];

const MobileTipSelector: React.FC<Props> = ({ selected, onSelect }) => {
  const { t } = useTranslation('pos');

  return (
    <div className="grid grid-cols-4 gap-2">
      {TIP_OPTIONS.map((opt) => {
        const isActive = opt.percent === selected;
        const label = opt.percent === null ? t('mobilePOS.tipNone') : opt.label;
        return (
          <button
            key={opt.label}
            onClick={() => onSelect(opt.percent)}
            className={`py-2.5 rounded-xl text-sm font-semibold transition-colors touch-manipulation ${
              isActive
                ? 'bg-brand-600 text-white'
                : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
};

export default React.memo(MobileTipSelector);
