import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CartItem } from '../../types';

export interface NotesModalProps {
  item: CartItem;
  onSave: (notes: string) => void;
  onClose: () => void;
}

const NotesModal: React.FC<NotesModalProps> = ({ item, onSave, onClose }) => {
  const [notes, setNotes] = useState(item.notes || '');
  const { t } = useTranslation('pos');

  const handleSave = () => {
    onSave(notes);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md max-h-96 border border-neutral-800">
        <div className="bg-brand-600 text-white p-6 rounded-t-2xl">
          <h2 className="text-2xl font-bold">{t('notes.title')}</h2>
          <p className="text-brand-100">{item.item_name}</p>
        </div>
        <div className="p-6 space-y-4">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('notes.placeholder')}
            className="w-full h-28 bg-neutral-800 border border-neutral-700 rounded-lg p-4 text-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
          />
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3 bg-neutral-700 text-white text-lg font-semibold rounded-lg hover:bg-neutral-600 transition-all"
            >
              {t('common:buttons.cancel')}
            </button>
            <button
              onClick={handleSave}
              className="flex-1 py-3 bg-brand-600 text-white text-lg font-semibold rounded-lg hover:bg-brand-700 transition-all"
            >
              {t('common:buttons.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NotesModal;
