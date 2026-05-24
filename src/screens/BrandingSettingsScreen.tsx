import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Upload, Check, Sun, Moon, Monitor } from 'lucide-react';
import { useBranding } from '../context/BrandingContext';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { getCurrentEmployeeToken } from '../api';
import BrandLogo from '../components/BrandLogo';
import { usePlan } from '../context/PlanContext';
import UpgradePrompt from '../components/UpgradePrompt';
import BackToSetupButton from '../components/BackToSetupButton';

const TIMEZONE_OPTIONS = [
  'America/Mexico_City',
  'America/Cancun',
  'America/Tijuana',
  'America/Monterrey',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Buenos_Aires',
  'America/Sao_Paulo',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/Madrid',
  'Europe/London',
  'UTC',
];

export default function BrandingSettingsScreen() {
  const { t } = useTranslation('admin');
  const { branding, refresh } = useBranding();
  const { currentEmployee } = useAuth();
  const { limits, timezone, refresh: refreshPlan } = usePlan();
  const { mode: themeMode, setMode: setThemeMode } = useTheme();

  const [restaurantName, setRestaurantName] = useState('');
  const [tagline, setTagline] = useState('');
  const [address, setAddress] = useState('');
  const [tz, setTz] = useState<string>('UTC');
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (branding) {
      setRestaurantName(branding.restaurantName || '');
      setTagline(branding.tagline || '');
      setAddress(branding.address || '');
      setLogoPreview(branding.logoUrl || null);
    }
  }, [branding]);

  useEffect(() => {
    setTz(timezone || 'UTC');
  }, [timezone]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setError(t('branding.fileTooLarge'));
      return;
    }

    setLogoFile(file);
    setLogoPreview(URL.createObjectURL(file));
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const token = getCurrentEmployeeToken();

      // Upload logo if changed
      if (logoFile) {
        const formData = new FormData();
        formData.append('logo', logoFile);
        const isCap = !!(window as any).Capacitor?.isNativePlatform?.();
        const tid = localStorage.getItem('tenant_id');
        const baseUrl = isCap && tid ? `https://${tid}.desktop.kitchen/api` : '/api';
        const logoRes = await fetch(`${baseUrl}/branding/logo`, {
          method: 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(!isCap && tid ? { 'X-Tenant-ID': tid } : {}),
          },
          body: formData,
        });

        if (!logoRes.ok) {
          const data = await logoRes.json();
          throw new Error(data.error || 'Failed to upload logo');
        }
      }

      // Save settings
      const isCap2 = !!(window as any).Capacitor?.isNativePlatform?.();
      const tid2 = localStorage.getItem('tenant_id');
      const baseUrl2 = isCap2 && tid2 ? `https://${tid2}.desktop.kitchen/api` : '/api';
      const settingsRes = await fetch(`${baseUrl2}/branding/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(!isCap2 && tid2 ? { 'X-Tenant-ID': tid2 } : {}),
        },
        body: JSON.stringify({ restaurantName, tagline, address }),
      });

      if (!settingsRes.ok) {
        const data = await settingsRes.json();
        throw new Error(data.error || 'Failed to save settings');
      }

      // Save timezone if changed
      if (tz && tz !== timezone) {
        const tzRes = await fetch(`${baseUrl2}/branding/timezone`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(!isCap2 && tid2 ? { 'X-Tenant-ID': tid2 } : {}),
          },
          body: JSON.stringify({ timezone: tz }),
        });
        if (!tzRes.ok) {
          const data = await tzRes.json();
          throw new Error(data.error || 'Failed to save timezone');
        }
        await refreshPlan();
      }

      // Refresh branding context
      await refresh();
      setLogoFile(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/admin"
              className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
            >
              <ArrowLeft size={24} />
            </Link>
            <h1 className="text-3xl font-black tracking-tighter">{t('branding.title')}</h1>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="max-w-3xl mx-auto p-6 space-y-8">
        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4">
            <p className="text-red-300">{error}</p>
          </div>
        )}

        {/* Restaurant Name */}
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
          <label className="block text-sm font-medium text-neutral-400 mb-2">
            {t('branding.restaurantName')}
          </label>
          <input
            type="text"
            value={restaurantName}
            onChange={(e) => setRestaurantName(e.target.value)}
            className="w-full bg-neutral-800 text-white rounded-lg px-4 py-3 border border-neutral-700 focus:border-brand-500 focus:outline-none"
            placeholder={t('branding.namePlaceholder')}
          />
        </div>

        {/* Tagline */}
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
          <label className="block text-sm font-medium text-neutral-400 mb-2">
            {t('branding.tagline')}
          </label>
          <input
            type="text"
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            className="w-full bg-neutral-800 text-white rounded-lg px-4 py-3 border border-neutral-700 focus:border-brand-500 focus:outline-none"
            placeholder={t('branding.taglinePlaceholder')}
          />
        </div>

        {/* Address */}
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
          <label className="block text-sm font-medium text-neutral-400 mb-2">
            {t('branding.receiptAddress')}
          </label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className="w-full bg-neutral-800 text-white rounded-lg px-4 py-3 border border-neutral-700 focus:border-brand-500 focus:outline-none"
            placeholder={t('branding.addressPlaceholder')}
          />
        </div>

        {/* Timezone */}
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
          <label className="block text-sm font-medium text-neutral-400 mb-2">
            {t('branding.timezone', 'Timezone')}
          </label>
          <p className="text-xs text-neutral-500 mb-3">
            {t('branding.timezoneHint', 'Sales reports group "today" / hourly data by this timezone.')}
          </p>
          <select
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            className="w-full bg-neutral-800 text-white rounded-lg px-4 py-3 border border-neutral-700 focus:border-brand-500 focus:outline-none"
          >
            {(TIMEZONE_OPTIONS.includes(tz) ? TIMEZONE_OPTIONS : [tz, ...TIMEZONE_OPTIONS]).map((z) => (
              <option key={z} value={z}>{z.replace('_', ' ')}</option>
            ))}
          </select>
        </div>

        {/* Logo Upload */}
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
          <label className="block text-sm font-medium text-neutral-400 mb-4">
            {t('branding.logo')}
          </label>
          <div className="flex items-center gap-6">
            <div className="w-24 h-24 bg-neutral-800 rounded-lg flex items-center justify-center overflow-hidden border border-neutral-700">
              {logoPreview ? (
                <img src={logoPreview} alt="Logo preview" className="max-w-full max-h-full object-contain" />
              ) : (
                <Upload className="text-neutral-600" size={32} />
              )}
            </div>
            <div>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 bg-neutral-800 text-white rounded-lg border border-neutral-700 hover:bg-neutral-700 transition-colors"
              >
                {t('branding.chooseLogo')}
              </button>
              <p className="text-xs text-neutral-500 mt-2">{t('branding.logoHint')}</p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>
          </div>
        </div>

        {/* Theme Mode */}
        <div className="bg-neutral-900 rounded-lg border border-neutral-800 p-6">
          <label className="block text-sm font-medium text-neutral-400 mb-4">
            {t('branding.theme')}
          </label>
          <div className="flex gap-3">
            {([
              { value: 'dark' as const, icon: Moon, label: t('branding.themeDark') },
              { value: 'light' as const, icon: Sun, label: t('branding.themeLight') },
              { value: 'system' as const, icon: Monitor, label: t('branding.themeSystem') },
            ]).map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                onClick={() => setThemeMode(value)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border transition-colors ${
                  themeMode === value
                    ? 'border-brand-500 bg-brand-600/15 text-brand-500'
                    : 'border-neutral-700 text-neutral-400 hover:border-neutral-600'
                }`}
              >
                <Icon size={18} />
                <span className="text-sm font-medium">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Save Button */}
        {!limits.branding.canRename && (
          <div className="mb-4">
            <UpgradePrompt message="Saving branding changes requires a paid plan." />
          </div>
        )}
        <button
          onClick={handleSave}
          disabled={saving || !limits.branding.canRename}
          className="w-full py-4 bg-brand-600 text-white font-bold text-lg rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {saving ? (
            t('branding.saving')
          ) : saved ? (
            <>
              <Check size={20} />
              {t('branding.saved')}
            </>
          ) : (
            t('branding.save')
          )}
        </button>
      </div>
      <BackToSetupButton />
    </div>
  );
}
