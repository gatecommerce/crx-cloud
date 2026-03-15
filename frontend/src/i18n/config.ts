export const SUPPORTED_LOCALES = ["it", "en", "fr", "de", "es", "pt", "ru", "ar"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "it";
export const RTL_LOCALES: Locale[] = ["ar"];

export function isRtl(locale: string): boolean {
  return RTL_LOCALES.includes(locale as Locale);
}

export function getDir(locale: string): "ltr" | "rtl" {
  return isRtl(locale) ? "rtl" : "ltr";
}
