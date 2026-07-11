import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Check, SlidersHorizontal, Trash2, Upload, Loader2 } from 'lucide-react';
import { MenuCategory, ModifierGroup } from '../../types';
import { FEATURES } from '../../lib/features';
import { uploadMenuImage, deleteMenuImage, extractMenuPhotoRef } from '../../api';

interface FormData {
  name: string;
  price: string;
  description: string;
  category_id: string;
  image_url: string;
  active: boolean;
}

type ModalMode = 'add' | 'edit' | null;

interface ItemFormModalProps {
  modalMode: ModalMode;
  formData: FormData;
  formErrors: Partial<Record<keyof FormData, string>>;
  actionLoading: boolean;
  categories: MenuCategory[];
  allModifierGroups: ModifierGroup[];
  assignedGroupIds: Set<number>;
  modifierLoading: boolean;
  onFormData: (data: FormData) => void;
  onAddItem: () => void;
  onEditItem: () => void;
  onDeleteItem?: () => void;
  onToggleModifierGroup: (groupId: number) => void;
  onClose: () => void;
}

export default function ItemFormModal({
  modalMode,
  formData,
  formErrors,
  actionLoading,
  categories,
  allModifierGroups,
  assignedGroupIds,
  modifierLoading,
  onFormData,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onToggleModifierGroup,
  onClose,
}: ItemFormModalProps) {
  const { t } = useTranslation('inventory');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Best-effort removal of the previously stored photo — only our own uploads
  // (externally-pasted URLs return null and are left alone). Non-critical: a
  // failed cleanup just leaves an orphaned object, never blocks the save.
  const cleanupPrevious = async (prevUrl: string | null | undefined) => {
    const ref = extractMenuPhotoRef(prevUrl);
    if (ref) {
      try {
        await deleteMenuImage(ref.tenantId, ref.uuid);
      } catch {
        /* orphan cleanup is non-critical */
      }
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    const previous = formData.image_url;
    try {
      const result = await uploadMenuImage(file);
      onFormData({ ...formData, image_url: result.image_url });
      void cleanupPrevious(previous);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : t('menu.form.uploadError'));
    } finally {
      setUploading(false);
    }
  };

  const handleRemovePhoto = () => {
    const previous = formData.image_url;
    onFormData({ ...formData, image_url: '' });
    void cleanupPrevious(previous);
  };

  if (!modalMode) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
      <div className="bg-neutral-900 rounded-lg border border-neutral-800 shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-white">
            {modalMode === 'add' ? t('menu.addMenuItem') : t('menu.editMenuItem')}
          </h2>
          <button
            onClick={() => { setConfirmDelete(false); onClose(); }}
            className="text-neutral-500 hover:text-neutral-300"
          >
            <X size={24} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">
              {t('menu.form.itemName')}
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => onFormData({ ...formData, name: e.target.value })}
              placeholder={t('menu.form.itemNamePlaceholder')}
              className="w-full px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
            />
            {formErrors.name && (
              <p className="text-brand-400 text-sm mt-1">{formErrors.name}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-2">
                {t('menu.form.price')}
              </label>
              <div className="flex items-center">
                <span className="text-neutral-400 font-medium">$</span>
                <input
                  type="number"
                  value={formData.price}
                  onChange={(e) => onFormData({ ...formData, price: e.target.value })}
                  placeholder="0.00"
                  step="0.01"
                  min="0"
                  className="w-full px-3 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600 ml-1"
                />
              </div>
              {formErrors.price && (
                <p className="text-brand-400 text-sm mt-1">{formErrors.price}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-2">
                {t('menu.form.category')}
              </label>
              <select
                value={formData.category_id}
                onChange={(e) => onFormData({ ...formData, category_id: e.target.value })}
                className="w-full px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white focus:outline-none focus:border-brand-600"
              >
                <option value="">{t('menu.form.selectCategory')}</option>
                {categories.filter(c => c.active).map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              {formErrors.category_id && (
                <p className="text-brand-400 text-sm mt-1">
                  {formErrors.category_id}
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">
              {t('menu.form.description')}
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => onFormData({ ...formData, description: e.target.value })}
              placeholder={t('menu.form.descriptionPlaceholder')}
              rows={3}
              className="w-full px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">
              {t('menu.form.photo')}
            </label>

            {formData.image_url && (
              <div className="mb-2 relative rounded-lg overflow-hidden border border-neutral-700 h-32 bg-neutral-800">
                <img
                  src={formData.image_url}
                  alt="Preview"
                  className="w-full h-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <button
                  type="button"
                  onClick={handleRemovePhoto}
                  className="absolute top-2 right-2 bg-black/60 hover:bg-black/80 text-white rounded-full p-1.5"
                  aria-label={t('menu.form.removePhoto')}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            )}

            {FEATURES.menuPhotos && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileSelected}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="w-full px-4 py-2 border border-neutral-700 rounded-lg text-neutral-300 hover:bg-neutral-800 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2 min-h-[44px]"
                >
                  {uploading ? <Loader2 size={18} className="animate-spin" /> : <Upload size={18} />}
                  {uploading
                    ? t('menu.form.uploading')
                    : formData.image_url
                      ? t('menu.form.replacePhoto')
                      : t('menu.form.uploadPhoto')}
                </button>
                {uploadError && <p className="text-brand-400 text-sm mt-1">{uploadError}</p>}
              </>
            )}

            <label className="block text-xs font-medium text-neutral-500 mt-3 mb-1">
              {t('menu.form.orPasteUrl')}
            </label>
            <input
              type="url"
              value={formData.image_url}
              onChange={(e) => onFormData({ ...formData, image_url: e.target.value })}
              placeholder={t('menu.form.imageUrlPlaceholder')}
              className="w-full px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:border-brand-600 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-2">
              {t('menu.form.visibility')}
            </label>
            <div className="flex bg-neutral-800 border border-neutral-700 rounded-lg p-1">
              <button
                type="button"
                onClick={() => onFormData({ ...formData, active: true })}
                className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors min-h-[40px] ${
                  formData.active
                    ? 'bg-cockpit-green text-white'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                {t('menu.liveMenu')}
              </button>
              <button
                type="button"
                onClick={() => onFormData({ ...formData, active: false })}
                className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors min-h-[40px] ${
                  !formData.active
                    ? 'bg-cockpit-yellow text-neutral-900'
                    : 'text-neutral-400 hover:text-white'
                }`}
              >
                {t('menu.preMenu')}
              </button>
            </div>
            <p className="text-neutral-500 text-xs mt-1">{t('menu.form.visibilityHint')}</p>
          </div>

          {/* Modifier Groups Assignment */}
          {allModifierGroups.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-2 flex items-center gap-2">
                <SlidersHorizontal size={16} />
                {t('menu.form.modifierGroups')}
              </label>
              {modifierLoading ? (
                <div className="bg-neutral-800 border border-neutral-700 rounded-lg p-3 animate-pulse h-16" />
              ) : (
                <div className="bg-neutral-800 border border-neutral-700 rounded-lg p-3 space-y-2 max-h-40 overflow-y-auto">
                  {allModifierGroups.map((group) => (
                    <label
                      key={group.id}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-neutral-700/50 cursor-pointer transition-colors"
                    >
                      <input
                        type="checkbox"
                        checked={assignedGroupIds.has(group.id)}
                        onChange={() => onToggleModifierGroup(group.id)}
                        className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 text-brand-600 focus:ring-brand-600 focus:ring-offset-0"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-white text-sm font-medium">{group.name}</span>
                        <span className="text-neutral-500 text-xs ml-2">
                          {group.selection_type === 'single' ? t('modifiers.singleSelectLabel') : t('modifiers.multiSelectLabel')}
                          {' · '}
                          {group.modifiers?.length || 0} {t('modifiers.optionsCount')}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              )}
              {allModifierGroups.length > 0 && assignedGroupIds.size === 0 && (
                <p className="text-neutral-500 text-xs mt-1">{t('menu.form.noModifiersHint')}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-3 mt-6">
          <button
            onClick={() => { setConfirmDelete(false); onClose(); }}
            className="flex-1 px-4 py-2 border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 transition-colors font-medium min-h-[44px]"
          >
            {t('common:buttons.cancel')}
          </button>
          <button
            onClick={modalMode === 'add' ? onAddItem : onEditItem}
            disabled={actionLoading}
            className="flex-1 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2 min-h-[44px]"
          >
            <Check size={20} />
            {actionLoading ? t('menu.form.saving') : modalMode === 'add' ? t('menu.addItem') : t('menu.form.saveChanges')}
          </button>
        </div>

        {modalMode === 'edit' && onDeleteItem && (
          <div className="mt-6 pt-6 border-t border-neutral-800">
            {confirmDelete ? (
              <div className="space-y-3">
                <p className="text-sm text-cockpit-out-text">
                  {t('menu.form.confirmDeleteItem', { name: formData.name })}
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={actionLoading}
                    className="flex-1 px-4 py-2 border border-neutral-700 text-neutral-300 rounded-lg hover:bg-neutral-800 transition-colors font-medium min-h-[44px] disabled:opacity-50"
                  >
                    {t('common:buttons.cancel')}
                  </button>
                  <button
                    onClick={onDeleteItem}
                    disabled={actionLoading}
                    className="flex-1 px-4 py-2 bg-cockpit-red text-white rounded-lg hover:bg-cockpit-red/90 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2 min-h-[44px]"
                  >
                    <Trash2 size={18} />
                    {actionLoading ? t('menu.form.deleting') : t('menu.form.confirmDelete')}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                disabled={actionLoading}
                className="w-full px-4 py-2 border border-cockpit-red text-cockpit-out-text rounded-lg hover:bg-cockpit-red/50 transition-colors font-medium disabled:opacity-50 flex items-center justify-center gap-2 min-h-[44px]"
              >
                <Trash2 size={18} />
                {t('menu.form.deleteItem')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
