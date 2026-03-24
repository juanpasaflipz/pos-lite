import React from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  invoiceId?: number;
  onCancelled?: () => void;
}

export default function CancellationModal({ isOpen, onClose }: Props) {
  if (!isOpen) return null;
  return null;
}
