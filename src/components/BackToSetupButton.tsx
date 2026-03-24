import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Rocket } from 'lucide-react';

/**
 * Floating button shown on admin screens when navigated from the onboarding checklist.
 * Detects `?from=setup` in the URL and provides a quick way back to the POS/checklist.
 */
export default function BackToSetupButton() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  if (searchParams.get('from') !== 'setup') return null;

  return (
    <button
      onClick={() => navigate('/pos')}
      className="fixed bottom-6 right-6 z-40 flex items-center gap-2 px-4 py-2.5 bg-brand-600 hover:bg-brand-500 text-white rounded-full shadow-lg shadow-brand-900/40 font-medium text-sm transition-colors"
    >
      <ArrowLeft size={16} />
      Back to Setup
      <Rocket size={14} />
    </button>
  );
}
