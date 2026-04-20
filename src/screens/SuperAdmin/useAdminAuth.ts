import { useCallback, useEffect, useState } from 'react';
import { verifySecret } from '../../api/superAdmin';

const STORAGE_KEY = 'admin_secret';

export type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

export function useAdminAuth() {
  const [state, setState] = useState<AuthState>('checking');

  useEffect(() => {
    const existing = sessionStorage.getItem(STORAGE_KEY);
    if (!existing) {
      setState('unauthenticated');
      return;
    }
    verifySecret().then((ok) => {
      if (!ok) sessionStorage.removeItem(STORAGE_KEY);
      setState(ok ? 'authenticated' : 'unauthenticated');
    });
  }, []);

  const signIn = useCallback(async (secret: string): Promise<boolean> => {
    sessionStorage.setItem(STORAGE_KEY, secret);
    const ok = await verifySecret();
    if (ok) {
      setState('authenticated');
      return true;
    }
    sessionStorage.removeItem(STORAGE_KEY);
    setState('unauthenticated');
    return false;
  }, []);

  const signOut = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY);
    setState('unauthenticated');
  }, []);

  return { state, signIn, signOut };
}
