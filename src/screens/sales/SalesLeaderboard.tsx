import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSalesAuth } from '../../context/SalesAuthContext';
import { getLeaderboard, type LeaderboardEntry } from '../../api/salesApi';

export default function SalesLeaderboard() {
  const { t } = useTranslation('sales');
  const { rep } = useSalesAuth();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    getLeaderboard()
      .then(setEntries)
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
      <h1 className="text-2xl font-bold text-white">{t('leaderboard.title')}</h1>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        {entries.length === 0 ? (
          <p className="text-neutral-500 text-sm px-5 py-8 text-center">No data yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800">
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium w-16">
                    {t('leaderboard.rank')}
                  </th>
                  <th className="text-left px-4 py-3 text-neutral-500 font-medium">
                    {t('leaderboard.name')}
                  </th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium">
                    {t('leaderboard.conversions')}
                  </th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium">
                    {t('leaderboard.clients')}
                  </th>
                  <th className="text-right px-4 py-3 text-neutral-500 font-medium">
                    {t('leaderboard.earned')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => {
                  const isCurrentRep = entry.id === rep?.id;
                  const rank = index + 1;
                  return (
                    <tr
                      key={entry.id}
                      className={`border-b border-neutral-800/50 ${
                        isCurrentRep ? 'bg-brand-600/10' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold ${
                            rank === 1
                              ? 'bg-yellow-500/20 text-yellow-400'
                              : rank === 2
                              ? 'bg-neutral-400/20 text-neutral-300'
                              : rank === 3
                              ? 'bg-orange-500/20 text-orange-400'
                              : 'bg-neutral-800 text-neutral-500'
                          }`}
                        >
                          {rank}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`font-medium ${isCurrentRep ? 'text-brand-400' : 'text-white'}`}>
                          {entry.name}
                        </span>
                        {isCurrentRep && (
                          <span className="ml-2 text-xs text-brand-500">(you)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right text-neutral-300">{entry.conversions}</td>
                      <td className="px-4 py-3 text-right text-neutral-300">{entry.clients}</td>
                      <td className="px-4 py-3 text-right text-green-400 font-medium">
                        ${Number(entry.total_earned).toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
