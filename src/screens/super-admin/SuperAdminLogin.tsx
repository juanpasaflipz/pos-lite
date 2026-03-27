import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { verifySecret } from '../../api/superAdmin';

interface Props {
  onAuth: () => void;
}

export default function SuperAdminLogin({ onAuth }: Props) {
  const { t } = useTranslation('superAdmin');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secret.trim()) return;

    setLoading(true);
    setError('');

    sessionStorage.setItem('admin_secret', secret.trim());

    try {
      const ok = await verifySecret();
      if (ok) {
        onAuth();
      } else {
        sessionStorage.removeItem('admin_secret');
        setError(t('login.invalidSecret'));
      }
    } catch {
      sessionStorage.removeItem('admin_secret');
      setError(t('login.invalidSecret'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="bg-neutral-900 rounded-2xl border border-neutral-800 p-8">
          <h1 className="text-2xl font-black text-white tracking-tight mb-1">
            {t('login.title')}
          </h1>
          <p className="text-neutral-400 text-sm mb-6">
            {t('login.description')}
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="password"
                value={secret}
                onChange={e => setSecret(e.target.value)}
                placeholder={t('login.placeholder')}
                className="w-full px-4 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-brand-600 focus:border-transparent transition-colors"
                autoFocus
                disabled={loading}
              />
            </div>

            {error && (
              <p className="text-red-400 text-sm">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading || !secret.trim()}
              className="w-full py-3 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
            >
              {loading ? t('login.verifying') : t('login.signIn')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
