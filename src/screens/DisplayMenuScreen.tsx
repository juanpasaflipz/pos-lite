import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink, MonitorPlay, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import {
  createDisplayAsset,
  deleteDisplayAsset,
  getCategories,
  getDisplayAssets,
  getDisplayMenuSettings,
  updateDisplayAsset,
  updateDisplayMenuSettings,
} from '../api';
import type { MenuCategory } from '../types';
import type { DisplayAsset, DisplayMenuSettings } from '../types/menu-board';
import BrandLogo from '../components/BrandLogo';

const EMPTY_SETTINGS: DisplayMenuSettings = {
  version: 1,
  tv: {
    enabled: false,
    layout: 'local_shop_split',
    menuCategoryIds: [],
    showPrices: true,
    showLogo: true,
    showTagline: true,
    footerText: '',
    rotationSeconds: 30,
    atmosphereMode: 'image_and_callout',
    activeAssetIds: [],
    seasonalCallout: {
      title: '',
      body: '',
      startsAt: null,
      endsAt: null,
    },
  },
  customerDisplay: {
    enabled: false,
    suggestiveSellingEnabled: true,
  },
  web: {
    enabled: false,
    allowOrdering: true,
  },
};

const EMPTY_ASSET_FORM = {
  kind: 'shop_photo' as DisplayAsset['kind'],
  title: '',
  body: '',
  image_url: '',
  sort_order: 0,
  active: true,
};

export default function DisplayMenuScreen() {
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [settings, setSettings] = useState<DisplayMenuSettings>(EMPTY_SETTINGS);
  const [assets, setAssets] = useState<DisplayAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [assetForm, setAssetForm] = useState(EMPTY_ASSET_FORM);
  const [assetSaving, setAssetSaving] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const previewUrl = useMemo(
    () => `${window.location.origin}${window.location.pathname}#/menu-board?preview=${previewNonce}`,
    [previewNonce]
  );

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        const [nextCategories, nextSettings, nextAssets] = await Promise.all([
          getCategories(true),
          getDisplayMenuSettings(),
          getDisplayAssets(),
        ]);
        setCategories(nextCategories);
        setSettings(nextSettings);
        setAssets(nextAssets);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load display menu settings');
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  const setTvField = <K extends keyof DisplayMenuSettings['tv']>(key: K, value: DisplayMenuSettings['tv'][K]) => {
    setSettings((current) => ({
      ...current,
      tv: {
        ...current.tv,
        [key]: value,
      },
    }));
  };

  const toggleCategory = (categoryId: number) => {
    const current = new Set(settings.tv.menuCategoryIds);
    if (current.has(categoryId)) current.delete(categoryId);
    else current.add(categoryId);
    setTvField('menuCategoryIds', Array.from(current));
  };

  const toggleAssetSelection = (assetId: number) => {
    const id = String(assetId);
    const current = new Set(settings.tv.activeAssetIds);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    setTvField('activeAssetIds', Array.from(current));
  };

  const handleSaveSettings = async () => {
    try {
      setSaving(true);
      const saved = await updateDisplayMenuSettings(settings);
      setSettings(saved);
      setMessage('Display menu settings saved.');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save display menu settings');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setAssetSaving(true);
      const created = await createDisplayAsset(assetForm);
      setAssets((current) => [...current, created].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id));
      setAssetForm(EMPTY_ASSET_FORM);
      setMessage('Display asset created.');
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create display asset');
    } finally {
      setAssetSaving(false);
    }
  };

  const handleAssetPatch = async (assetId: number, patch: Partial<DisplayAsset>) => {
    try {
      const updated = await updateDisplayAsset(assetId, patch);
      setAssets((current) => current.map((asset) => (asset.id === assetId ? updated : asset)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update display asset');
    }
  };

  const handleDeleteAsset = async (assetId: number) => {
    try {
      await deleteDisplayAsset(assetId);
      setAssets((current) => current.filter((asset) => asset.id !== assetId));
      setTvField(
        'activeAssetIds',
        settings.tv.activeAssetIds.filter((id) => id !== String(assetId))
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete display asset');
    }
  };

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-white">Loading display menu...</div>;
  }

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="border-b border-neutral-800 bg-neutral-900 p-6 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/admin" className="rounded-lg p-2 hover:bg-neutral-800 transition-colors">
              <ArrowLeft size={24} />
            </Link>
            <div>
              <h1 className="text-3xl font-black tracking-tighter">Display Menu</h1>
              <p className="mt-1 text-sm text-neutral-400">Configure the TV menu board and preview the live screen.</p>
            </div>
          </div>
          <BrandLogo className="h-10" />
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-6 p-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          {error ? (
            <div className="rounded-xl border border-red-800 bg-red-950/30 p-4 text-sm text-red-300">{error}</div>
          ) : null}
          {message ? (
            <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 p-4 text-sm text-emerald-300">{message}</div>
          ) : null}

          <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">TV Settings</h2>
                <p className="mt-1 text-sm text-neutral-400">Choose what shows on the in-store display and how the layout behaves.</p>
              </div>
              <button
                onClick={handleSaveSettings}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:opacity-60"
              >
                <Save size={18} />
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <label className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-950/60 px-4 py-3">
                <span className="text-sm text-white">Enable TV menu</span>
                <input
                  type="checkbox"
                  checked={settings.tv.enabled}
                  onChange={(e) => setTvField('enabled', e.target.checked)}
                  className="h-4 w-4"
                />
              </label>

              <label className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-950/60 px-4 py-3">
                <span className="text-sm text-white">Show prices</span>
                <input
                  type="checkbox"
                  checked={settings.tv.showPrices}
                  onChange={(e) => setTvField('showPrices', e.target.checked)}
                  className="h-4 w-4"
                />
              </label>

              <label className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-950/60 px-4 py-3">
                <span className="text-sm text-white">Show logo</span>
                <input
                  type="checkbox"
                  checked={settings.tv.showLogo}
                  onChange={(e) => setTvField('showLogo', e.target.checked)}
                  className="h-4 w-4"
                />
              </label>

              <label className="flex items-center justify-between rounded-xl border border-neutral-800 bg-neutral-950/60 px-4 py-3">
                <span className="text-sm text-white">Show tagline</span>
                <input
                  type="checkbox"
                  checked={settings.tv.showTagline}
                  onChange={(e) => setTvField('showTagline', e.target.checked)}
                  className="h-4 w-4"
                />
              </label>

              <label className="space-y-2 md:col-span-2">
                <span className="text-sm text-neutral-300">Footer text</span>
                <input
                  value={settings.tv.footerText || ''}
                  onChange={(e) => setTvField('footerText', e.target.value)}
                  className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
                  placeholder="Precios en MXN"
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm text-neutral-300">Rotation seconds</span>
                <input
                  type="number"
                  min={10}
                  max={120}
                  value={settings.tv.rotationSeconds}
                  onChange={(e) => setTvField('rotationSeconds', Number(e.target.value) || 30)}
                  className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
                />
              </label>
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="text-xl font-semibold text-white">Menu Categories</h2>
            <p className="mt-1 text-sm text-neutral-400">Pick the categories that should appear on the TV. If none are selected, all active categories will show.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {categories.map((category) => {
                const selected = settings.tv.menuCategoryIds.includes(category.id);
                return (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() => toggleCategory(category.id)}
                    className={`rounded-xl border px-4 py-3 text-left transition-colors ${
                      selected
                        ? 'border-brand-700 bg-brand-600/20 text-white'
                        : 'border-neutral-800 bg-neutral-950/60 text-neutral-300 hover:border-neutral-700'
                    }`}
                  >
                    <div className="font-medium">{category.name}</div>
                    <div className="mt-1 text-xs text-neutral-400">Sort order: {category.sort_order ?? 0}</div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <h2 className="text-xl font-semibold text-white">Seasonal Callout</h2>
            <p className="mt-1 text-sm text-neutral-400">This block appears under the atmosphere panel on the TV.</p>
            <div className="mt-5 grid gap-4">
              <input
                value={settings.tv.seasonalCallout.title || ''}
                onChange={(e) =>
                  setTvField('seasonalCallout', {
                    ...settings.tv.seasonalCallout,
                    title: e.target.value,
                  })
                }
                className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
                placeholder="Special de la casa"
              />
              <textarea
                value={settings.tv.seasonalCallout.body || ''}
                onChange={(e) =>
                  setTvField('seasonalCallout', {
                    ...settings.tv.seasonalCallout,
                    body: e.target.value,
                  })
                }
                rows={4}
                className="w-full rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
                placeholder="Fresh agua del dia, salsa de temporada, o una nota breve."
              />
            </div>
          </section>

          <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <div className="mb-5 flex items-center gap-3">
              <MonitorPlay className="text-brand-500" size={22} />
              <div>
                <h2 className="text-xl font-semibold text-white">Atmosphere Assets</h2>
                <p className="mt-1 text-sm text-neutral-400">Add neighborhood or shop imagery and choose which assets rotate on the display.</p>
              </div>
            </div>

            <form onSubmit={handleCreateAsset} className="grid gap-4 rounded-2xl border border-neutral-800 bg-neutral-950/60 p-4 md:grid-cols-2">
              <select
                value={assetForm.kind}
                onChange={(e) => setAssetForm((current) => ({ ...current, kind: e.target.value as DisplayAsset['kind'] }))}
                className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
              >
                <option value="shop_photo">Shop photo</option>
                <option value="neighborhood_photo">Neighborhood photo</option>
                <option value="seasonal_callout">Seasonal visual</option>
              </select>
              <input
                value={assetForm.image_url}
                onChange={(e) => setAssetForm((current) => ({ ...current, image_url: e.target.value }))}
                className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
                placeholder="Image URL or /uploads/..."
              />
              <input
                value={assetForm.title}
                onChange={(e) => setAssetForm((current) => ({ ...current, title: e.target.value }))}
                className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
                placeholder="Title"
              />
              <input
                type="number"
                value={assetForm.sort_order}
                onChange={(e) => setAssetForm((current) => ({ ...current, sort_order: Number(e.target.value) || 0 }))}
                className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
                placeholder="Sort order"
              />
              <textarea
                value={assetForm.body}
                onChange={(e) => setAssetForm((current) => ({ ...current, body: e.target.value }))}
                rows={3}
                className="md:col-span-2 rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-3 text-white focus:border-brand-500 focus:outline-none"
                placeholder="Short supporting line for the side panel."
              />
              <div className="md:col-span-2 flex justify-end">
                <button
                  type="submit"
                  disabled={assetSaving}
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-500 disabled:opacity-60"
                >
                  <Plus size={18} />
                  {assetSaving ? 'Adding...' : 'Add Asset'}
                </button>
              </div>
            </form>

            <div className="mt-5 space-y-4">
              {assets.map((asset) => {
                const selected = settings.tv.activeAssetIds.includes(String(asset.id));
                return (
                  <div key={asset.id} className="rounded-2xl border border-neutral-800 bg-neutral-950/60 p-4">
                    <div className="grid gap-4 md:grid-cols-[auto_1fr_auto] md:items-start">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleAssetSelection(asset.id)}
                          className="h-4 w-4"
                        />
                        <div className="text-xs uppercase tracking-[0.22em] text-neutral-500">{asset.kind.replace('_', ' ')}</div>
                      </div>

                      <div className="grid gap-3">
                        <input
                          value={asset.title || ''}
                          onChange={(e) => setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, title: e.target.value } : item))}
                          onBlur={(e) => handleAssetPatch(asset.id, { title: e.target.value })}
                          className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-2.5 text-white focus:border-brand-500 focus:outline-none"
                        />
                        <input
                          value={asset.image_url || ''}
                          onChange={(e) => setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, image_url: e.target.value } : item))}
                          onBlur={(e) => handleAssetPatch(asset.id, { image_url: e.target.value })}
                          className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-2.5 text-white focus:border-brand-500 focus:outline-none"
                        />
                        <textarea
                          value={asset.body || ''}
                          onChange={(e) => setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, body: e.target.value } : item))}
                          onBlur={(e) => handleAssetPatch(asset.id, { body: e.target.value })}
                          rows={2}
                          className="rounded-xl border border-neutral-700 bg-neutral-950 px-4 py-2.5 text-white focus:border-brand-500 focus:outline-none"
                        />
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="flex items-center gap-2 text-sm text-neutral-300">
                          <span>Order</span>
                          <input
                            type="number"
                            value={asset.sort_order}
                            onChange={(e) => setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, sort_order: Number(e.target.value) || 0 } : item))}
                            onBlur={(e) => handleAssetPatch(asset.id, { sort_order: Number(e.target.value) || 0 })}
                            className="w-20 rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-white focus:border-brand-500 focus:outline-none"
                          />
                        </label>
                        <label className="flex items-center gap-2 text-sm text-neutral-300">
                          <span>Active</span>
                          <input
                            type="checkbox"
                            checked={asset.active}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, active: checked } : item));
                              handleAssetPatch(asset.id, { active: checked });
                            }}
                            className="h-4 w-4"
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => handleDeleteAsset(asset.id)}
                          className="inline-flex items-center gap-2 rounded-lg border border-red-900 bg-red-950/30 px-3 py-2 text-sm text-red-300 hover:bg-red-950/50"
                        >
                          <Trash2 size={16} />
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900 p-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-white">Live Preview</h2>
                <p className="mt-1 text-sm text-neutral-400">This iframe renders the same public screen used on the TV.</p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
                >
                  <ExternalLink size={16} />
                  Open
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewNonce((current) => current + 1)}
                  className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800"
                >
                  <RefreshCw size={16} />
                  Refresh
                </button>
              </div>
            </div>
            <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950">
              <iframe title="Menu board preview" src={previewUrl} className="h-[720px] w-full bg-white" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
