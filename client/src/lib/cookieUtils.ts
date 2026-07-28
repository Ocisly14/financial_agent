import { deleteCookie } from 'cookies-next';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_INFO_COOKIE_KEY, USER_ROLE_COOKIE_KEY, COOKIE_DOMAIN } from '@/lib/constants';

/**
 * Get a cookie value from document.cookie by name
 * Used for reading CSRF tokens and other raw cookie values
 */
export function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;

  const cookies = document.cookie.split(';');
  for (let i = 0; i < cookies.length; i++) {
    const cookie = cookies[i].trim();
    if (cookie.substring(0, name.length + 1) === name + '=') {
      return decodeURIComponent(cookie.substring(name.length + 1));
    }
  }
  return null;
}

/**
 * Get CSRF token from cookies
 * Django typically sets this as 'csrftoken'
 */
export function getCsrfToken(): string | null {
  return getCookie('csrftoken');
}

/**
 * Delete a single cookie across multiple domains and paths
 * This ensures complete cleanup even if cookies were set with different configurations
 */
function deleteCookieEverywhere(name: string): void {
  const domains = [
    undefined, // Current domain
    COOKIE_DOMAIN,
    '.financialagent.ai',
    'financialagent.ai',
    '.localhost',
    'localhost',
  ];

  const paths = ['/', '/api', '/authentication'];

  // Delete cookie for each domain/path combination
  for (const domain of domains) {
    for (const path of paths) {
      try {
        deleteCookie(name, { domain, path });
        deleteCookie(name, { domain, path, sameSite: 'lax' });
        deleteCookie(name, { domain, path, sameSite: 'strict' });
        deleteCookie(name, { domain, path, sameSite: 'none', secure: true });
      } catch (error) {
        // Silently ignore errors - some combinations may not be valid
      }
    }
  }

  // Also try to delete directly from document.cookie as a fallback
  try {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=${COOKIE_DOMAIN}`;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.financialagent.ai`;
  } catch (error) {
    // Silently ignore errors
  }
}

/**
 * Delete all authentication-related cookies
 * Comprehensive cleanup across all domains and paths
 */
export function deleteAllAuthCookies(): void {
  const cookiesToDelete = [
    ACCESS_TOKEN_KEY,
    REFRESH_TOKEN_KEY,
    USER_INFO_COOKIE_KEY,
    USER_ROLE_COOKIE_KEY,
    'csrftoken', // Also clean CSRF token on logout
    'sessionid', // Clean Django session if present
  ];

  cookiesToDelete.forEach((cookieName) => {
    deleteCookieEverywhere(cookieName);
  });
}
