import React from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SecurityInfoModal({ open, onClose }: Props) {
  if (!open) return null;
  return null;
}
