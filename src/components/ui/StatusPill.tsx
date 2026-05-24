import React from 'react';
import { useTranslation } from 'react-i18next';

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'cancelled';

interface Props {
  status: OrderStatus | string;
  dot?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

interface StatusStyle {
  bg: string;
  text: string;
  dot: string;
}

const STATUS_STYLES: Record<OrderStatus, StatusStyle> = {
  pending:   { bg: 'bg-cockpit-blue',   text: 'text-white',       dot: 'bg-white' },
  confirmed: { bg: 'bg-cockpit-blue',   text: 'text-white',       dot: 'bg-white' },
  preparing: { bg: 'bg-cockpit-yellow', text: 'text-neutral-900', dot: 'bg-neutral-900' },
  ready:     { bg: 'bg-cockpit-green',  text: 'text-neutral-900', dot: 'bg-neutral-900' },
  completed: { bg: 'bg-neutral-600',    text: 'text-neutral-100', dot: 'bg-neutral-300' },
  cancelled: { bg: 'bg-cockpit-red',    text: 'text-white',       dot: 'bg-white' },
};

const FALLBACK_STYLE: StatusStyle = {
  bg: 'bg-neutral-600',
  text: 'text-neutral-200',
  dot: 'bg-neutral-300',
};

const SIZE_STYLES = {
  sm: { padding: 'px-2 py-0.5', text: 'text-xs', dot: 'w-1.5 h-1.5', gap: 'gap-1' },
  md: { padding: 'px-2.5 py-1',  text: 'text-xs', dot: 'w-2 h-2',     gap: 'gap-1.5' },
  lg: { padding: 'px-4 py-2',    text: 'text-sm', dot: 'w-2.5 h-2.5', gap: 'gap-2' },
};

export function getStatusStyle(status: string): StatusStyle {
  return (STATUS_STYLES as Record<string, StatusStyle>)[status] ?? FALLBACK_STYLE;
}

const StatusPill: React.FC<Props> = ({ status, dot = true, size = 'md', className = '' }) => {
  const { t } = useTranslation('kitchen');
  const styles = getStatusStyle(status);
  const s = SIZE_STYLES[size];
  const label = t(`status.${status}`, { defaultValue: status.toUpperCase() });

  return (
    <span
      className={`inline-flex items-center ${s.gap} ${s.padding} ${s.text} ${styles.bg} ${styles.text} rounded-full font-bold whitespace-nowrap ${className}`}
    >
      {dot && <span className={`${s.dot} ${styles.dot} rounded-full`} aria-hidden="true" />}
      {label}
    </span>
  );
};

export default StatusPill;
