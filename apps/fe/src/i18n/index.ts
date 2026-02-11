import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, I18N_RESOURCES } from '@tmex/shared';

void i18n
  .use(initReactI18next)
  .init({
    resources: I18N_RESOURCES,
    lng: DEFAULT_LOCALE,
    fallbackLng: DEFAULT_LOCALE,
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

export default i18n;
