import type { SubscriptionTier } from '@/hooks/useSubscriptionTier';

/**
 * Color configuration for user icons based on subscription tier
 */
const SUBSCRIPTION_COLORS = {
  free: {
    light: '#000000', // Black in light mode
    dark: '#FFFFFF',  // White in dark mode
  },
  plus: {
    gradient: 'linear-gradient(135deg, #10b981 0%, #14b8a6 50%, #06b6d4 100%)', // Green -> teal -> cyan
    fallback: '#14b8a6', // Teal as fallback for non-gradient contexts
  },
  pro: {
    gradient: 'linear-gradient(135deg, #ff9db0 0%, #d89fd8 50%, #a8c5e8 100%)', // Pink -> lavender -> blue
    fallback: '#d89fd8', // Lavender as fallback for non-gradient contexts
  },
  enterprise: {
    gradient: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 50%, #8b5cf6 100%)', // Blue -> indigo -> purple
    fallback: '#6366f1', // Indigo as fallback for non-gradient contexts
  },
};

export interface IconColorStyle {
  color?: string;
  background?: string;
  backgroundClip?: 'text';
  WebkitBackgroundClip?: 'text';
  WebkitTextFillColor?: 'transparent';
}

/**
 * Get the icon color class for a given subscription tier
 * For free tier, returns theme-aware classes (dark mode responsive)
 * For paid tiers, returns a fixed color
 *
 * @param tier - The subscription tier
 * @returns CSS class string or inline style object
 */
export const getIconColorClass = (tier: SubscriptionTier): string => {
  switch (tier) {
    case 'free':
      // Use Tailwind classes for theme-aware colors
      return 'text-black dark:text-white';
    case 'plus':
      return `text-[${SUBSCRIPTION_COLORS.plus.fallback}]`;
    case 'pro':
      return `text-[${SUBSCRIPTION_COLORS.pro.fallback}]`;
    case 'enterprise':
      return `text-[${SUBSCRIPTION_COLORS.enterprise.fallback}]`;
    default:
      return 'text-black dark:text-white';
  }
};

/**
 * Get the inline style object for icon color
 * Use this when you need direct style application instead of CSS classes
 * This approach is more reliable for custom colors in Tailwind
 *
 * For Pro tier, returns gradient background styles that should be applied to a wrapper element
 *
 * @param tier - The subscription tier
 * @param isDarkMode - Whether dark mode is active (only relevant for free tier)
 * @returns Style object with color property (and gradient for Pro tier)
 */
export const getIconColorStyle = (tier: SubscriptionTier, isDarkMode = false): IconColorStyle => {
  switch (tier) {
    case 'free':
      return { color: isDarkMode ? SUBSCRIPTION_COLORS.free.dark : SUBSCRIPTION_COLORS.free.light };
    case 'plus':
      // For Plus tier, return gradient background styles
      return {
        background: SUBSCRIPTION_COLORS.plus.gradient,
        backgroundClip: 'text',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      };
    case 'pro':
      // For Pro tier, return gradient background styles
      return {
        background: SUBSCRIPTION_COLORS.pro.gradient,
        backgroundClip: 'text',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      };
    case 'enterprise':
      // For Enterprise tier, return gradient background styles
      return {
        background: SUBSCRIPTION_COLORS.enterprise.gradient,
        backgroundClip: 'text',
        WebkitBackgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
      };
    default:
      return { color: isDarkMode ? SUBSCRIPTION_COLORS.free.dark : SUBSCRIPTION_COLORS.free.light };
  }
};

/**
 * Check if a tier requires gradient rendering
 * @param tier - The subscription tier
 * @returns true if the tier uses gradient colors
 */
export const isGradientTier = (tier: SubscriptionTier): boolean => {
  return tier === 'pro' || tier === 'plus' || tier === 'enterprise';
};

/**
 * Get the raw color hex value for a subscription tier
 * For Pro tier, returns the fallback color (since it uses gradient)
 *
 * @param tier - The subscription tier
 * @param isDarkMode - Whether dark mode is active (only relevant for free tier)
 * @returns Hex color string
 */
export const getIconColorHex = (tier: SubscriptionTier, isDarkMode = false): string => {
  switch (tier) {
    case 'free':
      return isDarkMode ? SUBSCRIPTION_COLORS.free.dark : SUBSCRIPTION_COLORS.free.light;
    case 'plus':
      return SUBSCRIPTION_COLORS.plus.fallback; // Return fallback color for gradient tier
    case 'pro':
      return SUBSCRIPTION_COLORS.pro.fallback; // Return fallback color for gradient tier
    case 'enterprise':
      return SUBSCRIPTION_COLORS.enterprise.fallback; // Return fallback color for gradient tier
    default:
      return isDarkMode ? SUBSCRIPTION_COLORS.free.dark : SUBSCRIPTION_COLORS.free.light;
  }
};
