import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { zhCN, en } from '@pontis/i18n';

const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('pontis:locale') : null;

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': zhCN,
    en,
  },
  lng: stored ?? 'zh-CN',
  fallbackLng: 'zh-CN',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
});

export function setLocale(locale: 'zh-CN' | 'en') {
  localStorage.setItem('pontis:locale', locale);
  void i18n.changeLanguage(locale);
}

export default i18n;
