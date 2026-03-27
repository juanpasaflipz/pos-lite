import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { getClients, type SalesClient } from '../../api/salesApi';

export default function SalesClientsScreen() {
  const { t } = useTranslation('sales');
  const navigate = useNavigate();
  const [clients, setClients] = useState<SalesClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getClients()
      .then(setClients)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="text-brand-600 animate-pulse">Loading...</div>
      </div>
    );
  }

  if (error) {
    return <div className="text-red-400 bg-red-900/20 border border-red-800 rounded-lg p-4">{error}</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">{t('clients.title')}</h1>

      {clients.length === 0 ? (
        <p className="text-neutral-500 text-center py-12">{t('clients.noClients')}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {clients.map((client) => (
            <button
              key={client.tenant_id}
              onClick={() => navigate(`/sales/clients/${client.tenant_id}`)}
              className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 text-left hover:border-neutral-700 transition"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">{client.name}</h3>
                  <p className="text-xs text-neutral-500 mt-0.5">{client.tenant_id}</p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    client.active
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-red-500/20 text-red-400'
                  }`}
                >
                  {client.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-neutral-500">{t('clients.plan')}</span>
                  <p className="text-neutral-300 font-medium capitalize">{client.plan}</p>
                </div>
                <div>
                  <span className="text-neutral-500">{t('clients.orders30d')}</span>
                  <p className="text-neutral-300 font-medium">{client.orders_30d}</p>
                </div>
                <div>
                  <span className="text-neutral-500">{t('clients.commission')}</span>
                  <p className="text-neutral-300 font-medium">{client.commission_percent}%</p>
                </div>
                {client.rep_name && (
                  <div>
                    <span className="text-neutral-500">{t('leads.assigned')}</span>
                    <p className="text-neutral-300 font-medium">{client.rep_name}</p>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
