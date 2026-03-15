import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./config";
import type { Locale } from "./config";

export { SUPPORTED_LOCALES, DEFAULT_LOCALE, RTL_LOCALES } from "./config";
export type { Locale } from "./config";

export default getRequestConfig(async () => {
  const store = await cookies();
  const raw = store.get("locale")?.value || DEFAULT_LOCALE;
  const locale = SUPPORTED_LOCALES.includes(raw as Locale) ? (raw as Locale) : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
