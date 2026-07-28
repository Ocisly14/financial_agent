import type React from 'react';
import { createContext, useContext, useEffect, type ReactNode } from 'react';

// financial-agent has no auth backend. This provider supplies a fixed, always
// authenticated anonymous user so the app boots straight into the chat shell.
// The exported `User` interface, `AuthContextType`, `useAuth` hook, and
// `AuthProvider` keep the same shape as before, so every consumer compiles and
// behaves unchanged. The /signin, /signup, /register routes stay mounted but
// are never navigated to.

export interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  institution?: string;
  job_title?: string;
  resolvedTier?: 'free' | 'plus' | 'pro' | 'enterprise';
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; message?: string }>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const ANON_USER: User = {
  id: 'anon-local',
  email: 'anonymous@local',
  first_name: 'Anonymous',
  last_name: 'User',
  resolvedTier: 'pro',
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  // Fire the auth-changed event once on mount; chat.tsx listens for it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent('financial-agent:auth-changed', {
        detail: { isAuthenticated: true },
      }),
    );
  }, []);

  const value: AuthContextType = {
    user: ANON_USER,
    isAuthenticated: true,
    isAdmin: false,
    isLoading: false,
    login: async () => ({ success: true }),
    logout: async () => { /* no-op: no auth backend */ },
    refreshAuth: async () => { /* no-op: no auth backend */ },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
