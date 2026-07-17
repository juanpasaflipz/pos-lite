import { useCallback, useEffect, useState } from 'react';
import { orgLogin, orgMe, clearOrgToken, getOrgToken, type OrgInfo } from '../../api/org';

export type OrgAuthState = 'checking' | 'authenticated' | 'unauthenticated';

export function useOrgAuth() {
  const [state, setState] = useState<OrgAuthState>('checking');
  const [org, setOrg] = useState<OrgInfo | null>(null);

  useEffect(() => {
    if (!getOrgToken()) {
      setState('unauthenticated');
      return;
    }
    orgMe()
      .then(({ org: o }) => {
        setOrg(o);
        setState('authenticated');
      })
      .catch(() => {
        clearOrgToken();
        setState('unauthenticated');
      });
  }, []);

  const signIn = useCallback(async (email: string, password: string): Promise<string | null> => {
    try {
      const o = await orgLogin(email, password);
      setOrg(o);
      setState('authenticated');
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Login failed';
    }
  }, []);

  const signOut = useCallback(() => {
    clearOrgToken();
    setOrg(null);
    setState('unauthenticated');
  }, []);

  return { state, org, signIn, signOut };
}
