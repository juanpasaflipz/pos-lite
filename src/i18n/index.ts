import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

// EN namespaces
import enCommon from './locales/en/common.json';
import enPos from './locales/en/pos.json';
import enKitchen from './locales/en/kitchen.json';
import enAdmin from './locales/en/admin.json';
import enInventory from './locales/en/inventory.json';
import enReports from './locales/en/reports.json';
import enFinancing from './locales/en/financing.json';
import enSettlement from './locales/en/settlement.json';
import enSuperAdmin from './locales/en/superAdmin.json';
import enOrg from './locales/en/org.json';
import enQrMenu from './locales/en/qrMenu.json';
import enCustomerOrder from './locales/en/customerOrder.json';
import enCockpit from './locales/en/cockpit.json';

// ES namespaces
import esCommon from './locales/es/common.json';
import esPos from './locales/es/pos.json';
import esKitchen from './locales/es/kitchen.json';
import esAdmin from './locales/es/admin.json';
import esInventory from './locales/es/inventory.json';
import esReports from './locales/es/reports.json';
import esFinancing from './locales/es/financing.json';
import esSettlement from './locales/es/settlement.json';
import esSuperAdmin from './locales/es/superAdmin.json';
import esOrg from './locales/es/org.json';
import esQrMenu from './locales/es/qrMenu.json';
import esCustomerOrder from './locales/es/customerOrder.json';
import esCockpit from './locales/es/cockpit.json';

const resources = {
  en: {
    common: enCommon,
    pos: enPos,
    kitchen: enKitchen,
    admin: enAdmin,
    inventory: enInventory,
    reports: enReports,
    financing: enFinancing,
    settlement: enSettlement,
    superAdmin: enSuperAdmin,
    org: enOrg,
    qrMenu: enQrMenu,
    customerOrder: enCustomerOrder,
    cockpit: enCockpit,
  },
  es: {
    common: esCommon,
    pos: esPos,
    kitchen: esKitchen,
    admin: esAdmin,
    inventory: esInventory,
    reports: esReports,
    financing: esFinancing,
    settlement: esSettlement,
    superAdmin: esSuperAdmin,
    org: esOrg,
    qrMenu: esQrMenu,
    customerOrder: esCustomerOrder,
    cockpit: esCockpit,
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'pos', 'kitchen', 'admin', 'inventory', 'reports', 'financing', 'settlement', 'superAdmin', 'org', 'qrMenu', 'customerOrder', 'cockpit'],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'dk-lang',
      caches: ['localStorage'],
    },
  });

// Sync document lang attribute on language change
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});

// Set initial lang attribute
document.documentElement.lang = i18n.language;

export default i18n;
