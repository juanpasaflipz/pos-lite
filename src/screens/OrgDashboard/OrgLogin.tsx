import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';

interface Props {
  onSignIn: (email: string, password: string) => Promise<string | null>;
}

const OrgLogin: React.FC<Props> = ({ onSignIn }) => {
  const { t } = useTranslation('org');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const err = await onSignIn(email, password);
    if (err) setError(err);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-neutral-900 border border-neutral-800 rounded-2xl p-8 space-y-5"
      >
        <div className="flex flex-col items-center gap-2 mb-2">
          <div className="w-12 h-12 rounded-xl bg-brand-600/20 text-brand-500 flex items-center justify-center">
            <Building2 size={24} />
          </div>
          <h1 className="text-xl font-bold text-white">{t('login.title')}</h1>
          <p className="text-sm text-neutral-400 text-center">{t('login.subtitle')}</p>
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
            {t('login.email')}
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
            className="w-full min-h-10 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-white focus:outline-none focus:border-brand-500"
          />
        </div>

        <div>
          <label className="block text-xs uppercase tracking-wider text-neutral-500 mb-1">
            {t('login.password')}
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full min-h-10 px-3 py-2 rounded-lg bg-neutral-800 border border-neutral-700 text-white focus:outline-none focus:border-brand-500"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full min-h-10 py-2.5 rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white font-semibold transition-colors"
        >
          {loading ? t('login.signingIn') : t('login.signIn')}
        </button>
      </form>
    </div>
  );
};

export default OrgLogin;
