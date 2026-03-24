import React from 'react';
import type { LoyaltyCustomer } from '../types';

interface Props {
  onCustomerLinked: (customer: LoyaltyCustomer) => void;
  onClose: () => void;
}

export default function CustomerLookupModal({ onCustomerLinked, onClose }: Props) {
  return null;
}
