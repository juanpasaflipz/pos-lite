import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { login as apiLogin, getMe, type SalesRep } from '../api/salesApi';

interface SalesAuthState {
  rep: SalesRep | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isManager: boolean;
}

const SalesAuthContext = createContext<SalesAuthState>({
  rep: null,
  loading: true,
  error: null,
  login: async () => {},
  logout: () => {},
  isManager: false,
});

export const useSalesAuth = () => useContext(SalesAuthContext);

export const SalesAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [rep, setRep] = useState<SalesRep | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check existing token on mount
  useEffect(() => {
    const token = sessionStorage.getItem('sales_token');
    if (!token) {
      setLoading(false);
      return;
    }

    getMe()
      .then(data => setRep(data.rep))
      .catch(() => {
        sessionStorage.removeItem('sales_token');
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const data = await apiLogin(email, password);
      sessionStorage.setItem('sales_token', data.token);
      setRep(data.rep);
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem('sales_token');
    setRep(null);
  }, []);

  return (
    <SalesAuthContext.Provider value={{ rep, loading, error, login, logout, isManager: rep?.role === 'manager' }}>
      {children}
    </SalesAuthContext.Provider>
  );
};
