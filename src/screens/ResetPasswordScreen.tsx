import React, { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { KeyRound, CheckCircle, AlertCircle } from 'lucide-react';
import { resetPassword } from '../api';
import { useTranslation } from 'react-i18next';

const ResetPasswordScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const token = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('token') || '';
  }, [location.search]);

  const { t } = useTranslation('common');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!token) {
      setError(t('resetPassword.invalidLink'));
      return;
    }

    if (newPassword.length < 8) {
      setError(t('resetPassword.passwordMinLength'));
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(t('resetPassword.passwordsNoMatch'));
      return;
    }

    setIsLoading(true);

    try {
      await resetPassword(token, newPassword);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('resetPassword.resetFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
            <span className="text-white font-bold text-sm">DK</span>
          </div>
          <span className="text-white font-semibold text-lg">Desktop Kitchen</span>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-8">

          {/* ==================== Success State ==================== */}
          {success ? (
            <div className="text-center space-y-6">
              <div className="w-16 h-16 rounded-full bg-teal-600/20 flex items-center justify-center mx-auto">
                <CheckCircle className="w-8 h-8 text-teal-400" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-white">{t('resetPassword.passwordReset')}</h1>
                <p className="text-neutral-400 mt-2">{t('resetPassword.passwordUpdated')}</p>
              </div>
              <button
                onClick={() => navigate('/')}
                className="px-6 py-3 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 transition-colors"
              >
                {t('resetPassword.signIn')}
              </button>
            </div>
          ) : (
            <>
              {/* ==================== Form State ==================== */}
              <div className="text-center">
                <div className="w-16 h-16 rounded-full bg-teal-600/20 flex items-center justify-center mx-auto mb-4">
                  <KeyRound className="w-8 h-8 text-teal-400" />
                </div>
                <h1 className="text-3xl font-bold text-white">{t('resetPassword.setNewPassword')}</h1>
                <p className="text-neutral-400 mt-2">{t('resetPassword.chooseStrong')}</p>
              </div>

              {!token && (
                <div className="p-3 rounded-lg bg-red-900/30 border border-red-800 text-red-400 text-sm flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  {t('resetPassword.invalidLinkLogin')}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1">{t('resetPassword.newPassword')}</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={e => { setNewPassword(e.target.value); setError(''); }}
                    placeholder={t('resetPassword.atLeast8')}
                    className="w-full px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-teal-600"
                    autoFocus
                    disabled={!token}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-300 mb-1">{t('resetPassword.confirmPassword')}</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={e => { setConfirmPassword(e.target.value); setError(''); }}
                    placeholder={t('resetPassword.repeatPassword')}
                    className="w-full px-4 py-3 bg-neutral-900 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-teal-600"
                    disabled={!token}
                  />
                </div>

                {error && (
                  <div className="p-3 rounded-lg bg-red-900/30 border border-red-800 text-red-400 text-sm">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isLoading || !token}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-teal-600 text-white font-semibold rounded-lg hover:bg-teal-700 transition-colors disabled:opacity-50"
                >
                  {isLoading ? t('resetPassword.resetting') : t('resetPassword.resetPasswordBtn')}
                </button>
              </form>
            </>
          )}

        </div>
      </main>
    </div>
  );
};

export default ResetPasswordScreen;
