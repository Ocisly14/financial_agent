import type { SubscriptionTier } from '@/hooks/useSubscriptionTier';

interface GradientUserIconProps {
  className?: string;
  tier?: SubscriptionTier;
}

/**
 * User icon with gradient color for Pro/Plus/Enterprise tiers
 * Uses SVG gradient definition for proper rendering
 */
export function GradientUserIcon({ className = 'h-4 w-4', tier = 'pro' }: GradientUserIconProps) {
  const gradientId = `user-icon-gradient-${tier}`;

  // Define gradient colors based on tier
  const gradientColors = {
    pro: {
      start: '#ff9db0',
      mid: '#d89fd8',
      end: '#a8c5e8',
    },
    plus: {
      start: '#10b981',
      mid: '#14b8a6',
      end: '#06b6d4',
    },
    enterprise: {
      start: '#3b82f6',
      mid: '#6366f1',
      end: '#8b5cf6',
    },
    free: {
      start: '#000000',
      mid: '#000000',
      end: '#000000',
    },
  };

  const colors = gradientColors[tier] || gradientColors.pro;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke={`url(#${gradientId})`}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={colors.start} />
          <stop offset="50%" stopColor={colors.mid} />
          <stop offset="100%" stopColor={colors.end} />
        </linearGradient>
      </defs>
      {/* User icon path from lucide-react */}
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
