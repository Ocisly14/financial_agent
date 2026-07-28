// API Configuration
export const API_BASE_URL = import.meta.env.NEXT_PUBLIC_API_BASE_URL || 'https://api.financialagent.ai/api';
//export const API_BASE_URL = import.meta.env.NEXT_PUBLIC_API_BASE_URL || 'http://api.financialagentdev.com:8000/api';
export const APP_HOST_DOMAIN = import.meta.env.VITE_APP_HOST_DOMAIN || 'http://localhost:5173';
export const ADMIN_EMAILS = import.meta.env.VITE_ADMIN_EMAILS || '';

// Cookie Keys
export const ACCESS_TOKEN_KEY = 'access_token';
export const REFRESH_TOKEN_KEY = 'refresh_token';
export const USER_INFO_COOKIE_KEY = 'user_info';
export const USER_ROLE_COOKIE_KEY = 'user_role';
export const COOKIE_DOMAIN = import.meta.env.VITE_COOKIE_DOMAIN || 'localhost';

// All UI cookies that need to be cleaned up on logout
export const UI_COOKIE_NAMES = [
  ACCESS_TOKEN_KEY,
  REFRESH_TOKEN_KEY,
  USER_INFO_COOKIE_KEY,
  USER_ROLE_COOKIE_KEY,
  'csrftoken',
  'sessionid',
] as const;

// Authentication
export const EMAIL_REG_TOKEN_LENGTH = 64;

// Default redirect URLs
export const REDIRECT_URL_ON_LOGIN_SUCCESS = '/';
export const FAIL_REDIRECT_URL = '/signup';
export const SUCCESS_REDIRECT_URL = '/signin';

// API Endpoints
export const API_ENDPOINTS = {
  AUTH: {
    LOGIN: '/authentication/validation/',
    SIGNUP_TOKEN: '/authentication/enrollment/token/',
    SIGNUP_CREATE: '/authentication/creation/',
    REFERRAL_LOOKUP: '/authentication/referral-lookup/',
    LOGOUT: '/authentication/logout/',
    REFRESH: '/authentication/refresh/',
    ME: '/authentication/me/',
  },
  HISTORY: {
    ANONYMOUS_CLEANUP: '/anonymous/cleanup',
  },
} as const;

// Countries for phone number selection
export const COUNTRIES = [
  { name: "United States", code: "US", dialCode: "+1" },
  { name: "Canada", code: "CA", dialCode: "+1" },
  { name: "Mexico", code: "MX", dialCode: "+52" },
  { name: "United Kingdom", code: "GB", dialCode: "+44" },
  { name: "Germany", code: "DE", dialCode: "+49" },
  { name: "France", code: "FR", dialCode: "+33" },
  { name: "India", code: "IN", dialCode: "+91" },
  { name: "China", code: "CN", dialCode: "+86" },
  { name: "Japan", code: "JP", dialCode: "+81" },
  { name: "Australia", code: "AU", dialCode: "+61" },
  { name: "Brazil", code: "BR", dialCode: "+55" },
  { name: "South Africa", code: "ZA", dialCode: "+27" },
  { name: "Russia", code: "RU", dialCode: "+7" },
  { name: "South Korea", code: "KR", dialCode: "+82" },
  { name: "Italy", code: "IT", dialCode: "+39" },
  { name: "Spain", code: "ES", dialCode: "+34" },
  { name: "Netherlands", code: "NL", dialCode: "+31" },
  { name: "Sweden", code: "SE", dialCode: "+46" },
  { name: "Switzerland", code: "CH", dialCode: "+41" },
  { name: "Norway", code: "NO", dialCode: "+47" },
  { name: "New Zealand", code: "NZ", dialCode: "+64" },
  { name: "Argentina", code: "AR", dialCode: "+54" },
  { name: "Saudi Arabia", code: "SA", dialCode: "+966" },
  { name: "United Arab Emirates", code: "AE", dialCode: "+971" },
] as const;
