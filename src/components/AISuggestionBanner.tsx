import React from 'react';
import type { AISuggestion } from '../types';

interface Props {
  suggestions: AISuggestion[];
  onAccept: (suggestion: AISuggestion) => void;
  onDismiss: (id: string) => void;
}

export default function AISuggestionBanner({ suggestions, onAccept, onDismiss }: Props) {
  if (!suggestions || suggestions.length === 0) return null;
  return null;
}
