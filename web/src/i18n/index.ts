import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zhCN, en } from '@pontis/i18n';

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': zhCN,
    en,
  },
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false, // React already escapes
  },
  ns: ['common', 'auth', 'explorer', 'sidebar'],
  defaultNS: 'common',
});

export default i18n;
