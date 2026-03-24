import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { Employee } from '../types';
import { loginEmployee as loginEmployeeApi, setCurrentEmployeeId, setCurrentEmployeeToken } from '../api';
import { offlineDb, type CachedEmployee } from '../lib/offlineDb';

interface AuthContextType {
  currentEmployee: Employee | null;
  permissions: string[];
  isLoading: boolean;
  error: string | null;
  login: (pin: string) => Promise<void>;
  logout: () => void;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

/** SHA-256 hash a PIN string using Web Crypto API */
async function hashPin(pin: string): Promise<string> {
  const data = new TextEncoder().encode(pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cache employee + hashed PIN to IndexedDB for offline login */
async function cacheEmployee(employee: Employee, pin: string): Promise<void> {
  try {
    const pinHash = await hashPin(pin);
    const cached: CachedEmployee = {
      id: employee.id,
      name: employee.name,
      role: employee.role,
      active: employee.active,
      permissions: employee.permissions || [],
      pinHash,
      token: employee.token || null,
      cachedAt: Date.now(),
    };
    await offlineDb.employees.put(cached);
  } catch {
    // IndexedDB write failed — non-critical
  }
}

/** Attempt offline login by hashing PIN and matching against cached employees */
async function offlineLogin(pin: string): Promise<Employee | null> {
  try {
    const pinHash = await hashPin(pin);
    const allCached = await offlineDb.employees.toArray();
    const match = allCached.find((e) => e.pinHash === pinHash && e.active);
    if (!match) return null;
    return {
      id: match.id,
      name: match.name,
      role: match.role,
      active: match.active,
      permissions: match.permissions,
      token: match.token || undefined,
      created_at: '',
    };
  } catch {
    return null;
  }
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  // Check for stored demo employee (set by demo token auto-login flow)
  const storedDemo = (() => {
    try {
      const raw = localStorage.getItem('demo_employee');
      if (raw) {
        const emp = JSON.parse(raw);
        // Clear it so it's single-use
        localStorage.removeItem('demo_employee');
        // Set API module state
        setCurrentEmployeeId(emp.id);
        setCurrentEmployeeToken(emp.token || null);
        return emp as Employee;
      }
    } catch { /* ignore */ }
    return null;
  })();

  const [currentEmployee, setCurrentEmployee] = useState<Employee | null>(storedDemo);
  const [permissions, setPermissions] = useState<string[]>(storedDemo?.permissions || []);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (pin: string) => {
    setIsLoading(true);
    setError(null);
    try {
      // Try online login first
      const employee = await loginEmployeeApi(pin);
      setCurrentEmployee(employee);
      setPermissions(employee.permissions || []);
      setCurrentEmployeeId(employee.id);
      setCurrentEmployeeToken(employee.token || null);
      // Cache for future offline use
      await cacheEmployee(employee, pin);
    } catch (err) {
      // Online failed — try offline fallback
      const offlineEmployee = await offlineLogin(pin);
      if (offlineEmployee) {
        setCurrentEmployee(offlineEmployee);
        setPermissions(offlineEmployee.permissions || []);
        setCurrentEmployeeId(offlineEmployee.id);
        setCurrentEmployeeToken(offlineEmployee.token || null);
        return; // success via offline
      }
      const errorMessage = err instanceof Error ? err.message : 'Login failed';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    setCurrentEmployee(null);
    setPermissions([]);
    setCurrentEmployeeId(null);
    setCurrentEmployeeToken(null);
    setError(null);
  }, []);

  const hasPermission = useCallback((permission: string) => {
    if (!currentEmployee) return false;
    if (currentEmployee.role === 'admin') return true;
    return permissions.includes(permission);
  }, [currentEmployee, permissions]);

  const value: AuthContextType = {
    currentEmployee,
    permissions,
    isLoading,
    error,
    login,
    logout,
    hasPermission,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
