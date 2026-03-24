import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowLeft, Lock, Eye, EyeOff, Check, AlertCircle, Trash2 } from 'lucide-react';
import {
  getCredentialsSchema,
  getCredentials,
  saveCredentials,
  deleteCredentials,
  type ServiceSchema,
} from '../api';

const SERVICE_ICONS: Record<string, string> = {
  mercadopago: '\uD83D\uDCF1',
  stripe: '\uD83D\uDCB3',
  twilio: '\uD83D\uDCE8',
  facturapi: '\uD83E\uDDFE',
  xai: '\uD83E\uDDE0',
  uber_eats: '\uD83C\uDF54',
  rappi: '\uD83E\uDDCA',
  didi_food: '\uD83D\uDE95',
};

const SERVICE_GROUP_KEYS: { labelKey: string; keys: string[] }[] = [
  { labelKey: 'integrations.groups.payments', keys: ['mercadopago', 'stripe'] },
  { labelKey: 'integrations.groups.delivery', keys: ['uber_eats', 'rappi', 'didi_food'] },
  { labelKey: 'integrations.groups.communications', keys: ['twilio'] },
  { labelKey: 'integrations.groups.invoicing', keys: ['facturapi'] },
  { labelKey: 'integrations.groups.ai', keys: ['xai'] },
];

interface ServiceCardProps {
  serviceKey: string;
  schema: ServiceSchema;
  stored: Record<string, string>;
  onSave: (service: string, values: Record<string, string>) => Promise<void>;
  onDelete: (service: string) => Promise<void>;
  t: (key: string, opts?: any) => string;
}

function ServiceCard({ serviceKey, schema, stored, onSave, onDelete, t }: ServiceCardProps) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hasStored = Object.values(stored).some(v => v && v.length > 0);

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const field of schema.fields) {
      init[field.key] = stored[field.key] || '';
    }
    setValues(init);
  }, [stored, schema.fields]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const toSend: Record<string, string> = {};
      for (const field of schema.fields) {
        const val = values[field.key] || '';
        if (field.secret && stored[field.key] && val === stored[field.key]) continue;
        toSend[field.key] = val;
      }
      await onSave(serviceKey, toSend);
      setSaved(true);
      setEditing(false);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err.message || t('integrations.errorSaving'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    setError('');
    try {
      await onDelete(serviceKey);
      const cleared: Record<string, string> = {};
      for (const field of schema.fields) cleared[field.key] = '';
      setValues(cleared);
      setConfirmDelete(false);
      setEditing(false);
    } catch (err: any) {
      setError(err.message || t('integrations.errorDeleting'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-lg overflow-hidden">
      <div className="p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">{SERVICE_ICONS[serviceKey] || '\u2699\uFE0F'}</span>
            <h3 className="text-lg font-bold text-white">{schema.label}</h3>
          </div>
          <div className="flex items-center gap-2">
            {hasStored && (
              <span className="text-xs font-semibold text-green-400 bg-green-400/10 px-2 py-0.5 rounded-full">
                {t('integrations.configured')}
              </span>
            )}
            {saved && (
              <span className="text-xs font-semibold text-teal-400 flex items-center gap-1">
                <Check size={12} /> {t('integrations.saved')}
              </span>
            )}
          </div>
        </div>
        <p className="text-neutral-500 text-sm mb-4">
          {t(`integrations.services.${serviceKey}`, '')}
        </p>

        {!editing ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setEditing(true)}
              className="px-4 py-2 bg-neutral-800 text-neutral-200 text-sm font-semibold rounded-lg hover:bg-neutral-700 transition-colors"
            >
              {hasStored ? t('integrations.editCredentials') : t('integrations.configure')}
            </button>
            {hasStored && (
              <button
                onClick={() => setConfirmDelete(true)}
                className="p-2 text-neutral-600 hover:text-red-400 transition-colors"
                title={t('integrations.deleteCredentials')}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {schema.fields.map((field) => (
              <div key={field.key}>
                <label className="block text-neutral-400 text-xs uppercase tracking-wider mb-1">
                  {field.label}
                  {field.secret && <Lock size={10} className="inline ml-1 -mt-0.5" />}
                </label>
                <div className="relative">
                  <input
                    type={field.secret && !showSecrets[field.key] ? 'password' : 'text'}
                    value={values[field.key] || ''}
                    onChange={(e) => setValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                    placeholder={field.secret ? (stored[field.key] || '') : ''}
                    className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 pr-10 text-white text-sm font-mono focus:outline-none focus:border-brand-500"
                  />
                  {field.secret && (
                    <button
                      type="button"
                      onClick={() => setShowSecrets(prev => ({ ...prev, [field.key]: !prev[field.key] }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
                    >
                      {showSecrets[field.key] ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  )}
                </div>
              </div>
            ))}

            {error && (
              <p className="text-red-400 text-sm flex items-center gap-1">
                <AlertCircle size={14} /> {error}
              </p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2 bg-brand-600 text-white text-sm font-semibold rounded-lg hover:bg-brand-700 transition-colors disabled:opacity-50"
              >
                {saving ? t('integrations.saving') : t('integrations.save')}
              </button>
              <button
                onClick={() => { setEditing(false); setError(''); }}
                disabled={saving}
                className="px-4 py-2 text-neutral-400 text-sm font-medium hover:text-white transition-colors"
              >
                {t('common:buttons.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Delete confirmation */}
        {confirmDelete && (
          <div className="mt-3 bg-red-900/20 border border-red-800/40 rounded-lg p-3 flex items-center justify-between">
            <p className="text-red-300 text-sm">{t('integrations.deleteConfirm', { service: schema.label })}</p>
            <div className="flex gap-2">
              <button
                onClick={handleDelete}
                disabled={saving}
                className="px-3 py-1.5 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50"
              >
                {t('common:buttons.delete')}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 text-neutral-400 text-xs font-medium hover:text-white"
              >
                {t('common:buttons.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function IntegrationsScreen() {
  const { t } = useTranslation('admin');
  const [schema, setSchema] = useState<Record<string, ServiceSchema> | null>(null);
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [schemaData, credsData] = await Promise.all([
          getCredentialsSchema(),
          getCredentials(),
        ]);
        setSchema(schemaData);
        setCredentials(credsData);
      } catch (err: any) {
        if (err.message?.includes('401') || err.message?.includes('403')) {
          setError('');
        } else {
          setError(err.message || 'Error loading');
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleSave = async (service: string, values: Record<string, string>) => {
    await saveCredentials(service, values);
    const fresh = await getCredentials();
    setCredentials(fresh);
  };

  const handleDelete = async (service: string) => {
    await deleteCredentials(service);
    setCredentials(prev => ({ ...prev, [service]: {} }));
  };

  return (
    <div className="min-h-screen bg-neutral-950">
      <div className="bg-neutral-900 text-white p-6 border-b border-neutral-800">
        <div className="flex items-center gap-4">
          <Link to="/admin" className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
            <ArrowLeft size={24} />
          </Link>
          <div>
            <h1 className="text-3xl font-black tracking-tighter">{t('integrations.title')}</h1>
            <p className="text-neutral-400 text-sm mt-0.5">{t('integrations.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto p-6">
        {loading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="bg-neutral-900 border border-neutral-800 rounded-lg p-6 animate-pulse">
                <div className="h-20 bg-neutral-800 rounded" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="bg-red-900/30 border border-red-800 rounded-lg p-4">
            <p className="text-red-300">{error}</p>
          </div>
        ) : schema ? (
          <div className="space-y-6">
            <div className="bg-neutral-800/50 border border-neutral-700/50 rounded-lg p-4">
              <p className="text-neutral-300 text-sm">
                {t('integrations.credentialsNote')}
              </p>
            </div>
            {SERVICE_GROUP_KEYS.map((group) => {
              const groupServices = group.keys.filter(k => schema[k]);
              if (groupServices.length === 0) return null;
              return (
                <div key={group.labelKey}>
                  <h2 className="text-neutral-500 text-xs font-bold uppercase tracking-widest mb-3 px-1">
                    {t(group.labelKey)}
                  </h2>
                  <div className="space-y-4">
                    {groupServices.map((key) => (
                      <ServiceCard
                        key={key}
                        serviceKey={key}
                        schema={schema[key]}
                        stored={credentials[key] || {}}
                        onSave={handleSave}
                        onDelete={handleDelete}
                        t={t}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
