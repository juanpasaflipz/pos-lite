import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { OrderTemplate } from '../../types';

interface QuickOrdersModalProps {
  templates: OrderTemplate[];
  hasCartItems: boolean;
  hasPermission: boolean;
  showSaveTemplate: boolean;
  templateName: string;
  onClose: () => void;
  onApplyTemplate: (template: OrderTemplate) => void;
  onSaveCartAsTemplate: () => void;
  onTemplateNameChange: (name: string) => void;
  onShowSaveTemplate: (show: boolean) => void;
}

export default function QuickOrdersModal({
  templates,
  hasCartItems,
  hasPermission,
  showSaveTemplate,
  templateName,
  onClose,
  onApplyTemplate,
  onSaveCartAsTemplate,
  onTemplateNameChange,
  onShowSaveTemplate,
}: QuickOrdersModalProps) {
  const { t } = useTranslation('pos');

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-neutral-900 rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] border border-neutral-800 flex flex-col">
        <div className="bg-emerald-600 text-white p-6 rounded-t-2xl flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">{t('quickOrders.title')}</h2>
            <p className="text-emerald-100 text-sm">{t('quickOrders.subtitle')}</p>
          </div>
          <button onClick={onClose} className="text-emerald-200 hover:text-white">
            <X className="w-6 h-6" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {templates.length === 0 ? (
            <p className="text-neutral-500 text-center py-8">{t('quickOrders.noTemplates')}</p>
          ) : (
            templates.map((template) => (
              <button
                key={template.id}
                onClick={() => onApplyTemplate(template)}
                className="w-full text-left bg-neutral-800 border border-neutral-700 rounded-lg p-4 hover:border-emerald-600 transition-all"
              >
                <p className="font-bold text-white">{template.name}</p>
                {template.description && (
                  <p className="text-neutral-400 text-sm mt-1">{template.description}</p>
                )}
                <p className="text-neutral-500 text-xs mt-2">
                  {t('quickOrders.itemCount', { count: template.items.length })}
                </p>
              </button>
            ))
          )}
        </div>
        {/* Save current cart as template (managers/admins only) */}
        {hasPermission && hasCartItems && (
          <div className="border-t border-neutral-800 p-4">
            {showSaveTemplate ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={templateName}
                  onChange={(e) => onTemplateNameChange(e.target.value)}
                  placeholder={t('quickOrders.enterName')}
                  className="w-full px-4 py-3 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-emerald-600"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => onShowSaveTemplate(false)}
                    className="flex-1 py-2 bg-neutral-700 text-white font-semibold rounded-lg hover:bg-neutral-600"
                  >
                    {t('common:buttons.cancel')}
                  </button>
                  <button
                    onClick={onSaveCartAsTemplate}
                    disabled={!templateName.trim()}
                    className="flex-1 py-2 bg-emerald-600 text-white font-semibold rounded-lg hover:bg-emerald-700 disabled:bg-neutral-700 disabled:text-neutral-500"
                  >
                    {t('common:buttons.save')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => onShowSaveTemplate(true)}
                className="w-full py-3 bg-neutral-800 text-emerald-400 font-bold rounded-lg hover:bg-neutral-700 border border-neutral-700 transition-all"
              >
                {t('quickOrders.saveCurrentCart')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
