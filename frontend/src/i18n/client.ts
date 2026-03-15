"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { SUPPORTED_LOCALES, type Locale, RTL_LOCALES } from "./config";

export { SUPPORTED_LOCALES, RTL_LOCALES };
export type { Locale };

export const LOCALE_LABELS: Record<Locale, string> = {
  it: "Italiano",
  en: "English",
  fr: "Français",
  de: "Deutsch",
  es: "Español",
  pt: "Português",
  ru: "Русский",
  ar: "العربية",
};

export const LOCALE_FLAGS: Record<Locale, string> = {
  it: "IT",
  en: "EN",
  fr: "FR",
  de: "DE",
  es: "ES",
  pt: "PT",
  ru: "RU",
  ar: "AR",
};

export function useLocaleSwitch() {
  const router = useRouter();

  const switchLocale = useCallback(
    (locale: Locale) => {
      document.cookie = `locale=${locale};path=/;max-age=31536000;samesite=lax`;
      router.refresh();
    },
    [router],
  );

  return switchLocale;
}

export { isRtl, getDir } from "./config";
