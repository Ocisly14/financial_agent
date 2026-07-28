import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';

export type SubscriptionTier = 'free' | 'plus' | 'pro' | 'enterprise';

interface UseSubscriptionTierResult {
  tier: SubscriptionTier;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Hook to get the current user's subscription tier
 * Tier comes from auth payload (`/authentication/me`) which is synced from tier history.
 */
export const useSubscriptionTier = (): UseSubscriptionTierResult => {
  const { user, isAuthenticated } = useAuth();
  const [tier, setTier] = useState<SubscriptionTier>('free');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // If not authenticated, default to free.
    if (!isAuthenticated || !user?.email) {
      setTier('free');
      setError(null);
      setIsLoading(false);
      return;
    }

    // Optional override for test users via env (e.g. VITE_TEST_USER_EMAIL, VITE_TEST_USER_TIER)
    const testUserEmail = import.meta.env.VITE_TEST_USER_EMAIL?.toLowerCase();
    const testUserTier = import.meta.env.VITE_TEST_USER_TIER?.toLowerCase();
    const allowedTiers: SubscriptionTier[] = ['free', 'plus', 'pro', 'enterprise'];
    if (testUserEmail && user.email.toLowerCase() === testUserEmail) {
      const overrideTier = allowedTiers.includes(testUserTier as SubscriptionTier)
        ? (testUserTier as SubscriptionTier)
        : 'free';
      setTier(overrideTier);
      setError(null);
      setIsLoading(false);
      return;
    }

    // Logged-in tier is served by /authentication/me and persisted in tier history.
    const resolvedTier = user.resolvedTier;
    if (resolvedTier && allowedTiers.includes(resolvedTier)) {
      setTier(resolvedTier);
    } else {
      setTier('free');
    }
    setError(null);
    setIsLoading(false);
  }, [isAuthenticated, user?.email, user?.resolvedTier]);

  return { tier, isLoading, error };
};
