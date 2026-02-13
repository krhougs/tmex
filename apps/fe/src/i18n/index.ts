import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, I18N_RESOURCES, type LocaleCode } from '@tmex/shared';

// Detect browser language
function detectBrowserLocale(): LocaleCode {
  const browserLang = navigator.language;
  if (browserLang.startsWith('zh')) return 'zh_CN';
  if (browserLang.startsWith('ja')) return 'ja_JP';
  return DEFAULT_LOCALE;
}

void i18n
  .use(initReactI18next)
  .init({
    resources: I18N_RESOURCES,
    lng: detectBrowserLocale(),
    fallbackLng: DEFAULT_LOCALE,
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

export default i18n;
