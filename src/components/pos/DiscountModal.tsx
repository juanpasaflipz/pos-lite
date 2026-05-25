import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Percent, DollarSign, Gift } from 'lucide-react';
import { Discount, DiscountType } from '../../types';
import { formatPrice } from '../../utils/currency';
import { useAuth } from '../../context/AuthContext';
import ManagerApprovalModal from './ManagerApprovalModal';

interface DiscountModalProps {
  base: number;
  scope: 'cart' | 'item';
  itemName?: string;
  initialDiscount?: Discount | null;
  onSave: (discount: Discount | null) => void;
  onClose: () => void;
}

const PERMISSION = 'apply_discounts';

const DiscountModal: React.FC<DiscountModalProps> = ({
  base,
  scope,
  itemName,
  initialDiscount,
  onSave,
  onClose,
}) => {
  const { t } = useTranslation('pos');
  const { hasPermission, currentEmployee } = useAuth();

  const [type, setType] = useState<DiscountType>(initialDiscount?.type || 'percent');
  const [valueText, setValueText] = useState(
    initialDiscount && initialDiscount.type !== 'comp' ? String(initialDiscount.value) : ''
  );
  const [reason, setReason] = useState(initialDiscount?.reason || '');
  const [authorizer, setAuthorizer] = useState<{ id: number; name: string } | null>(
    initialDiscount?.authorized_by_employee_id && initialDiscount.authorized_by_employee_name
      ? { id: initialDiscount.authorized_by_employee_id, name: initialDiscount.authorized_by_employee_name }
      : null
  );
  const [showApproval, setShowApproval] = useState(false);

  const numericValue = type === 'comp' ? 0 : Math.max(0, Number(valueText) || 0);

  const computedAmount = useMemo(() => {
    if (type === 'comp') return base;
    if (type === 'percent') {
      const pct = Math.min(100, numericValue);
      return Math.round(base * (pct / 100) * 100) / 100;
    }
    return Math.min(base, Math.round(numericValue * 100) / 100);
  }, [type, numericValue, base]);

  const newTotal = Math.max(0, base - computedAmount);
  const canApply = hasPermission(PERMISSION) || !!authorizer;
  const ownerHasPerm = hasPermission(PERMISSION);

  const valid =
    reason.trim().length > 0 &&
    (type === 'comp' || numericValue > 0) &&
    computedAmount > 0;

  const submit = () => {
    if (!valid) return;
    if (!canApply) {
      setShowApproval(true);
      return;
    }
    const discount: Discount = {
      type,
      value: type === 'comp' ? 100 : numericValue,
      reason: reason.trim(),
    };
    if (!ownerHasPerm && authorizer) {
      discount.authorized_by_employee_id = authorizer.id;
      discount.authorized_by_employee_name = authorizer.name;
    } else if (ownerHasPerm && currentEmployee) {
      discount.authorized_by_employee_id = currentEmployee.id;
      discount.authorized_by_employee_name = currentEmployee.name;
    }
    onSave(discount);
  };

  const remove = () => onSave(null);

  return (
    <>
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md border border-neutral-800">
          <div className="bg-cockpit-yellow text-neutral-900 p-5 rounded-t-2xl">
            <h2 className="text-xl font-bold">{t('discount.title')}</h2>
            <p className="text-cockpit-attention-text text-sm">
              {scope === 'cart' ? t('discount.scopeCart') : t('discount.scopeItem', { name: itemName || '' })}
            </p>
          </div>

          <div className="p-5 space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <TypeButton active={type === 'percent'} onClick={() => setType('percent')} icon={<Percent className="w-4 h-4" />} label={t('discount.percent')} />
              <TypeButton active={type === 'amount'} onClick={() => setType('amount')} icon={<DollarSign className="w-4 h-4" />} label={t('discount.amount')} />
              <TypeButton active={type === 'comp'} onClick={() => setType('comp')} icon={<Gift className="w-4 h-4" />} label={t('discount.comp')} />
            </div>

            {type !== 'comp' && (
              <div>
                <label className="block text-neutral-400 text-xs font-bold uppercase tracking-wider mb-1">
                  {type === 'percent' ? t('discount.percentValue') : t('discount.amountValue')}
                </label>
                <div className="relative">
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max={type === 'percent' ? 100 : base}
                    step={type === 'percent' ? '1' : '0.01'}
                    value={valueText}
                    onChange={(e) => setValueText(e.target.value)}
                    placeholder={type === 'percent' ? '10' : '50.00'}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-lg text-white placeholder-neutral-500 focus:outline-none focus:border-cockpit-yellow"
                    autoFocus
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 text-lg pointer-events-none">
                    {type === 'percent' ? '%' : '$'}
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-neutral-400 text-xs font-bold uppercase tracking-wider mb-1">
                {t('discount.reason')} *
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('discount.reasonPlaceholder')}
                className="w-full h-20 bg-neutral-800 border border-neutral-700 rounded-lg p-3 text-white placeholder-neutral-500 focus:outline-none focus:border-cockpit-yellow"
              />
            </div>

            <div className="bg-neutral-800 rounded-lg p-3 space-y-1">
              <Row label={t('discount.previewBase')} value={formatPrice(base)} />
              <Row label={t('discount.previewDiscount')} value={`-${formatPrice(computedAmount)}`} highlight />
              <div className="border-t border-neutral-700 pt-1">
                <Row label={t('discount.previewNew')} value={formatPrice(newTotal)} bold />
              </div>
            </div>

            {!ownerHasPerm && (
              <div className="bg-cockpit-yellow/30 border border-cockpit-yellow rounded-lg p-3">
                {authorizer ? (
                  <p className="text-cockpit-attention-text text-sm">
                    {t('discount.approvedBy', { name: authorizer.name })}
                  </p>
                ) : (
                  <p className="text-cockpit-attention-text text-sm">
                    {t('discount.requiresManager')}
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                onClick={onClose}
                className="flex-1 py-3 bg-neutral-700 text-white text-base font-semibold rounded-lg hover:bg-neutral-600 transition-all"
              >
                {t('common:buttons.cancel')}
              </button>
              {initialDiscount && (
                <button
                  onClick={remove}
                  className="px-4 py-3 bg-cockpit-red text-white text-base font-semibold rounded-lg hover:bg-cockpit-red/90 transition-all"
                >
                  {t('discount.remove')}
                </button>
              )}
              <button
                onClick={submit}
                disabled={!valid}
                className="flex-1 py-3 bg-cockpit-yellow text-neutral-900 text-base font-bold rounded-lg hover:bg-cockpit-yellow/90 disabled:bg-neutral-800 disabled:text-neutral-600 transition-all"
              >
                {t('discount.apply')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {showApproval && (
        <ManagerApprovalModal
          permission={PERMISSION}
          title={t('discount.managerTitle')}
          message={t('discount.managerMessage')}
          onApproved={(result) => {
            setAuthorizer({ id: result.employee_id, name: result.employee_name });
            setShowApproval(false);
          }}
          onClose={() => setShowApproval(false)}
        />
      )}
    </>
  );
};

const TypeButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}> = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={`flex flex-col items-center gap-1 py-3 rounded-lg border transition-all ${
      active
        ? 'bg-cockpit-yellow border-cockpit-yellow text-neutral-900'
        : 'bg-neutral-800 border-neutral-700 text-neutral-300 hover:bg-neutral-700'
    }`}
  >
    {icon}
    <span className="text-xs font-bold">{label}</span>
  </button>
);

const Row: React.FC<{ label: string; value: string; bold?: boolean; highlight?: boolean }> = ({
  label, value, bold, highlight,
}) => (
  <div className="flex justify-between text-sm">
    <span className={highlight ? 'text-cockpit-attention-text' : 'text-neutral-400'}>{label}</span>
    <span className={`${bold ? 'text-white font-bold' : highlight ? 'text-cockpit-attention-text font-semibold' : 'text-neutral-200'}`}>
      {value}
    </span>
  </div>
);

export default DiscountModal;
