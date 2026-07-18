// Kiosk-local i18n instance — deliberately separate from the POS app's i18n.
//
// Spanish is the default and the reset target. English is opt-in per customer
// via the ES/EN toggle (AttractScreen + KioskMenuScreen header). There is NO
// browser language detector on purpose: a shared kiosk must never inherit the
// previous customer's — or the device browser's — language. AttractScreen
// calls resetKioskLanguage() on mount so every new customer starts in Spanish.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from './es.json';
import en from './en.json';

i18n.use(initReactI18next).init({
  resources: { es: { kiosk: es }, en: { kiosk: en } },
  lng: 'es',
  fallbackLng: 'es',
  defaultNS: 'kiosk',
  interpolation: { escapeValue: false },
  returnEmptyString: false,
});

/** Every customer starts in Spanish — called when the attract screen mounts. */
export function resetKioskLanguage() {
  if (i18n.language !== 'es') void i18n.changeLanguage('es');
}

export default i18n;
