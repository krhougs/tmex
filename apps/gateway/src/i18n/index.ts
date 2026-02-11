import i18next from 'i18next';
import { I18N_RESOURCES } from '@tmex/shared';

i18next.init({
  resources: I18N_RESOURCES,
  lng: 'en_US',
  fallbackLng: 'en_US',
  interpolation: {
    escapeValue: false,
  },
});

export { i18next };
export const t = i18next.t.bind(i18next);
