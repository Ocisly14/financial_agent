import type { User } from "@/contexts/AuthContext";

const DEFAULT_TEST_EMAIL = "test@test.com";

export function getUserDisplayName(user: User | null): string {
  if (!user?.email) {
    return "User";
  }

  const testUserEmail = (import.meta.env.VITE_TEST_USER_EMAIL ?? DEFAULT_TEST_EMAIL).toLowerCase();
  if (user.email.toLowerCase() === testUserEmail) {
    return "Financial Agent";
  }

  return user.email;
}
