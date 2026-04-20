import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';

interface Props {
  onSignIn: (secret: string) => Promise<boolean>;
}

const SuperAdminLogin: React.FC<Props> = ({ onSignIn }) => {
  const { t } = useTranslation('superAdmin');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const ok = await onSignIn(secret.trim());
    if (!ok) {
      setError(t('login.invalidSecret'));
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl p-8 shadow-2xl"
      >
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-14 h-14 rounded-full bg-brand-900/40 border border-brand-700 flex items-center justify-center mb-4">
            <ShieldCheck className="w-7 h-7 text-brand-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t('login.title')}</h1>
          <p className="text-sm text-neutral-400 mt-2">{t('login.description')}</p>
        </div>

        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={t('login.placeholder')}
          autoFocus
          autoComplete="off"
          className="w-full px-4 py-3 bg-neutral-950 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30 transition"
        />

        {error && (
          <p className="mt-3 text-sm text-red-400 text-center">{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting || !secret.trim()}
          className="mt-6 w-full py-3 bg-brand-600 hover:bg-brand-500 active:bg-brand-700 text-white font-semibold rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? t('login.verifying') : t('login.signIn')}
        </button>
      </form>
    </div>
  );
};

export default SuperAdminLogin;
