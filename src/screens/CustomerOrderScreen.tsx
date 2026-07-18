import React, { useState, useEffect, useReducer, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useBranding } from '../context/BrandingContext';
import {
  placeCustomerOrder,
  getCustomerOrderStatus,
  type CustomerOrderItem,
  type CustomerOrderStatus,
} from '../api/customerOrder';
import { ShoppingCart, Plus, Minus, X, Check, Loader2, Clock, ChefHat, Bell, RefreshCw, Wallet } from 'lucide-react';

/* ==================== Types ==================== */

interface MenuItemData {
  id: number;
  name: string;
  price: number;
  description?: string;
  image_url?: string | null;
}

interface CategoryData {
  id: number;
  name: string;
  items: MenuItemData[];
}

interface BrandData {
  id: number;
  name: string;
  categories: CategoryData[];
  theme: { primaryColor: string };
}

interface ModifierData {
  id: number;
  name: string;
  price_adjustment: number;
}

interface ModifierGroupData {
  id: number;
  name: string;
  selection_type: 'single' | 'multi';
  required: boolean;
  min_selections: number;
  max_selections: number;
  modifiers?: ModifierData[];
}

interface CartItem {
  cartId: string;
  menu_item_id: number;
  name: string;
  price: number;
  quantity: number;
  notes: string;
  modifiers: ModifierData[];
}

/* ==================== localStorage helpers ==================== */

const ACTIVE_ORDER_KEY = 'qr_active_order';

function saveActiveOrder(orderId: number, secret: string) {
  try {
    localStorage.setItem(ACTIVE_ORDER_KEY, JSON.stringify({ orderId, secret, ts: Date.now() }));
  } catch { /* ignore */ }
}

function loadActiveOrder(): { orderId: number; secret: string } | null {
  try {
    const raw = localStorage.getItem(ACTIVE_ORDER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    // Expire after 4 hours, or drop if a pre-secret entry is still around
    if (Date.now() - data.ts > 4 * 60 * 60 * 1000 || !data.secret) {
      localStorage.removeItem(ACTIVE_ORDER_KEY);
      return null;
    }
    return { orderId: data.orderId, secret: data.secret };
  } catch {
    return null;
  }
}

function clearActiveOrder() {
  try { localStorage.removeItem(ACTIVE_ORDER_KEY); } catch { /* ignore */ }
}

/* ==================== Cart Reducer ==================== */

type CartAction =
  | { type: 'ADD_ITEM'; item: CartItem }
  | { type: 'REMOVE_ITEM'; cartId: string }
  | { type: 'UPDATE_QTY'; cartId: string; quantity: number }
  | { type: 'CLEAR' };

function cartReducer(state: CartItem[], action: CartAction): CartItem[] {
  switch (action.type) {
    case 'ADD_ITEM':
      return [...state, action.item];
    case 'REMOVE_ITEM':
      return state.filter(i => i.cartId !== action.cartId);
    case 'UPDATE_QTY':
      return action.quantity <= 0
        ? state.filter(i => i.cartId !== action.cartId)
        : state.map(i => i.cartId === action.cartId ? { ...i, quantity: action.quantity } : i);
    case 'CLEAR':
      return [];
    default:
      return state;
  }
}

/* ==================== Status Tracker ==================== */

function getStepIndex(status: string): number {
  // Post-collapse, in-flight orders all sit at status='active' through the
  // entire kitchen window — map that to step 1 (Preparing) so the customer
  // doesn't skip the milestone. Legacy names handled the same way.
  if (status === 'ready' || status === 'completed') return 2;
  if (status === 'preparing' || status === 'confirmed' || status === 'active') return 1;
  return 0; // pending
}

// Show only the last 4 characters of the order number so the customer sees
// a short ticket ID that matches what the cashier reads on the KDS/receipt.
function short(orderNumber: string | number | undefined | null): string {
  if (orderNumber === null || orderNumber === undefined) return '…';
  const s = String(orderNumber);
  return s.slice(-4);
}

function OrderStatusTracker({ orderId, orderSecret, onNewOrder }: {
  orderId: number;
  orderSecret: string;
  onNewOrder: () => void;
}) {
  const { t } = useTranslation('customerOrder');
  const [status, setStatus] = useState<CustomerOrderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await getCustomerOrderStatus(orderId, orderSecret);
      setStatus(data);
      setError(null);

      // Stop polling when order is ready/completed/cancelled
      if (['ready', 'completed', 'cancelled'].includes(data.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
      }

      // Clear localStorage if completed
      if (data.status === 'completed' || data.status === 'cancelled') {
        clearActiveOrder();
      }
    } catch (err) {
      setError(t('tracking.statusError'));
    }
  }, [orderId, orderSecret, t]);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  const stepIndex = status ? getStepIndex(status.status) : 0;
  const isReady = status && (status.status === 'ready' || status.status === 'completed');

  const steps = [
    { key: 'placed', label: t('tracking.steps.placed'), icon: Check },
    { key: 'preparing', label: t('tracking.steps.preparing'), icon: ChefHat },
    { key: 'ready', label: t('tracking.steps.ready'), icon: Bell },
  ];

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-6">
      <div className="bg-neutral-900 rounded-2xl p-6 max-w-sm w-full border border-neutral-800">
        {/* Order number — last 4 only */}
        <div className="text-center mb-6">
          <p className="text-neutral-500 text-sm mb-1">{t('tracking.yourOrder')}</p>
          <p className="text-5xl font-black text-brand-500 tracking-tight">
            #{short(status?.order_number)}
          </p>
        </div>

        {/* Pay at cashier banner — the whole flow is pay-at-counter, so surface
            this prominently as soon as the ticket is placed */}
        <div className="bg-cockpit-attention/15 border border-cockpit-attention/40 rounded-xl p-4 mb-6 flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-cockpit-attention/25 flex items-center justify-center flex-shrink-0">
            <Wallet size={18} className="text-cockpit-attention-text" />
          </div>
          <div className="min-w-0">
            <p className="text-white font-bold text-base">{t('tracking.payAtCashierTitle')}</p>
            <p className="text-neutral-400 text-sm mt-0.5">{t('tracking.payAtCashierSubtitle')}</p>
          </div>
        </div>

        {/* Status stepper */}
        <div className="flex items-center justify-between mb-8 px-2">
          {steps.map((step, i) => {
            const Icon = step.icon;
            const isActive = i <= stepIndex;
            const isCurrent = i === stepIndex;
            return (
              <React.Fragment key={step.key}>
                {i > 0 && (
                  <div className={`flex-1 h-0.5 mx-1 transition-colors duration-500 ${
                    i <= stepIndex ? 'bg-brand-500' : 'bg-neutral-700'
                  }`} />
                )}
                <div className="flex flex-col items-center gap-1.5">
                  <div className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-500 ${
                    isActive
                      ? isCurrent && isReady
                        ? 'bg-cockpit-green scale-110'
                        : 'bg-brand-600'
                      : 'bg-neutral-800 border border-neutral-700'
                  }`}>
                    <Icon size={20} className={isActive ? 'text-white' : 'text-neutral-500'} />
                  </div>
                  <span className={`text-xs font-medium ${
                    isActive ? 'text-white' : 'text-neutral-600'
                  }`}>
                    {step.label}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* Ready state */}
        {isReady && (
          <div className="bg-cockpit-green/15 border border-cockpit-green/40 rounded-xl p-4 text-center mb-4 animate-pulse">
            <p className="text-cockpit-in-text font-bold text-lg">{t('tracking.readyTitle')}</p>
            <p className="text-cockpit-in-text/70 text-sm mt-1">{t('tracking.readySubtitle')}</p>
          </div>
        )}

        {/* Estimated time */}
        {!isReady && status?.estimated_ready_minutes && (
          <div className="flex items-center justify-center gap-2 text-neutral-400 mb-4">
            <Clock size={16} />
            <span className="text-sm">
              {t('tracking.estimated', { minutes: status.estimated_ready_minutes })}
            </span>
          </div>
        )}

        {/* Error */}
        {error && (
          <p className="text-cockpit-out-text text-sm text-center mb-4">{error}</p>
        )}

        {/* Actions */}
        <div className="space-y-3">
          {!isReady && (
            <button
              onClick={fetchStatus}
              className="w-full bg-neutral-800 hover:bg-neutral-700 text-neutral-300 font-medium py-3 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm"
            >
              <RefreshCw size={14} />
              {t('tracking.refresh')}
            </button>
          )}
          <button
            onClick={() => {
              clearActiveOrder();
              onNewOrder();
            }}
            className="w-full bg-brand-600 hover:bg-brand-700 text-white font-bold py-3 rounded-xl transition-colors"
          >
            {isReady ? t('tracking.orderAgain') : t('tracking.placeAnother')}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ==================== Main Component ==================== */

// Table QR is a pay-at-counter model: send to kitchen, pick up + pay at the
// cashier. The pre-pay stage was removed so there is no card-payment language
// on the customer's phone. Keep the two remaining stages as-is.
type Stage = 'menu' | 'tracking';

export default function CustomerOrderScreen() {
  const { t } = useTranslation('customerOrder');
  const { branding } = useBranding();
  const [searchParams] = useSearchParams();
  const tableNumber = searchParams.get('table') || undefined;

  // Data
  const [brands, setBrands] = useState<BrandData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stage + order state
  const [stage, setStage] = useState<Stage>('menu');
  const [orderId, setOrderId] = useState<number | null>(null);
  const [orderSecret, setOrderSecret] = useState<string | null>(null);

  // UI state
  const [activeCategory, setActiveCategory] = useState<number | null>(null);
  const [selectedItem, setSelectedItem] = useState<MenuItemData | null>(null);
  const [modifierGroups, setModifierGroups] = useState<ModifierGroupData[]>([]);
  const [selectedModifiers, setSelectedModifiers] = useState<Record<number, number[]>>({});
  const [itemQty, setItemQty] = useState(1);
  const [itemNotes, setItemNotes] = useState('');
  const [loadingModifiers, setLoadingModifiers] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Cart
  const [cart, dispatch] = useReducer(cartReducer, []);
  const categoryScrollRef = useRef<HTMLDivElement>(null);
  const activePillRef = useRef<HTMLButtonElement>(null);

  // Scroll-spy refs
  const categoryRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const isManualScroll = useRef(false);

  // Check for existing active order on mount
  useEffect(() => {
    const existing = loadActiveOrder();
    if (existing) {
      setOrderId(existing.orderId);
      setOrderSecret(existing.secret);
      setStage('tracking');
    }
  }, []);

  // Load menu data.
  // `?source=kiosk` bypasses the virtual-brands path — that path returns each
  // item once per assigned brand, and the frontend then flattens every brand's
  // categories, which duplicates any item that belongs to more than one brand.
  // The QR customer just wants a single flat menu ordered by category/item
  // sort, so we take the regular-menu branch of the endpoint.
  useEffect(() => {
    if (stage !== 'menu') return;
    fetch('/api/customer-order/menu?source=kiosk').then(r => r.json())
      .then((menuData) => {
        // Parse prices to numbers (Postgres returns NUMERIC as strings)
        const brandList: BrandData[] = (menuData.brands || menuData || []).map((b: BrandData) => ({
          ...b,
          categories: b.categories.map(c => ({
            ...c,
            items: c.items.map(item => ({ ...item, price: Number(item.price) })),
          })),
        }));
        setBrands(brandList);

        // Set first category as active
        const firstCat = brandList[0]?.categories?.[0];
        if (firstCat) setActiveCategory(firstCat.id);
      }).catch(err => {
        setError(t('menu.loadError'));
        console.error(err);
      }).finally(() => setLoading(false));
  }, [stage, t]);

  // Auto-scroll active category pill into view
  useEffect(() => {
    if (activePillRef.current) {
      activePillRef.current.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [activeCategory]);

  // Scroll-spy: update active category as user scrolls
  useEffect(() => {
    if (stage !== 'menu') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (isManualScroll.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const catId = Number(entry.target.getAttribute('data-cat-id'));
            if (catId) setActiveCategory(catId);
          }
        }
      },
      { threshold: 0.3, rootMargin: '-120px 0px -50% 0px' }
    );

    categoryRefs.current.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [stage, brands]);

  // All categories flattened
  const allCategories = brands.flatMap(b => b.categories);
  const brandName = branding?.restaurantName || brands[0]?.name || t('menu.brandFallback');

  // Cart totals
  const cartItemCount = cart.reduce((sum, i) => sum + i.quantity, 0);
  const cartTotal = cart.reduce((sum, i) => {
    const modTotal = i.modifiers.reduce((ms, m) => ms + m.price_adjustment, 0);
    return sum + (i.price + modTotal) * i.quantity;
  }, 0);

  // Open item detail
  const openItem = useCallback(async (item: MenuItemData) => {
    setSelectedItem(item);
    setItemQty(1);
    setItemNotes('');
    setSelectedModifiers({});
    setModifierGroups([]);
    setLoadingModifiers(true);

    // Haptic feedback
    try { navigator.vibrate?.(10); } catch { /* ignore */ }

    try {
      const res = await fetch(`/api/modifiers/groups/item/${item.id}`);
      if (res.ok) {
        const groups: ModifierGroupData[] = (await res.json()).map((g: ModifierGroupData) => ({
          ...g,
          modifiers: g.modifiers?.map(m => ({ ...m, price_adjustment: Number(m.price_adjustment) })),
        }));
        setModifierGroups(groups);
        // Pre-select required single-select defaults
        const defaults: Record<number, number[]> = {};
        for (const g of groups) {
          if (g.required && g.selection_type === 'single' && g.modifiers?.[0]) {
            defaults[g.id] = [g.modifiers[0].id];
          }
        }
        setSelectedModifiers(defaults);
      }
    } catch {
      // modifiers optional
    } finally {
      setLoadingModifiers(false);
    }
  }, []);

  // Toggle modifier
  const toggleModifier = useCallback((groupId: number, modId: number, selectionType: 'single' | 'multi', maxSelections: number) => {
    setSelectedModifiers(prev => {
      const current = prev[groupId] || [];
      if (selectionType === 'single') {
        return { ...prev, [groupId]: [modId] };
      }
      // multi
      if (current.includes(modId)) {
        return { ...prev, [groupId]: current.filter(id => id !== modId) };
      }
      if (maxSelections > 0 && current.length >= maxSelections) {
        return prev;
      }
      return { ...prev, [groupId]: [...current, modId] };
    });
  }, []);

  // Add to cart
  const addToCart = useCallback(() => {
    if (!selectedItem) return;

    const allMods: ModifierData[] = [];
    for (const g of modifierGroups) {
      const ids = selectedModifiers[g.id] || [];
      for (const id of ids) {
        const mod = g.modifiers?.find(m => m.id === id);
        if (mod) allMods.push(mod);
      }
    }

    dispatch({
      type: 'ADD_ITEM',
      item: {
        cartId: crypto.randomUUID(),
        menu_item_id: selectedItem.id,
        name: selectedItem.name,
        price: selectedItem.price,
        quantity: itemQty,
        notes: itemNotes,
        modifiers: allMods,
      },
    });

    // Haptic feedback
    try { navigator.vibrate?.(15); } catch { /* ignore */ }
    setSelectedItem(null);
  }, [selectedItem, modifierGroups, selectedModifiers, itemQty, itemNotes]);

  // Send order to the kitchen. No pre-pay stage — the table-QR flow is always
  // pay-at-cashier, so the ticket goes straight to tracking after submit.
  const handlePlaceOrder = useCallback(async () => {
    if (cart.length === 0) return;
    setSubmitting(true);
    setError(null);

    try {
      const items: CustomerOrderItem[] = cart.map(ci => ({
        menu_item_id: ci.menu_item_id,
        quantity: ci.quantity,
        notes: ci.notes || undefined,
        modifiers: ci.modifiers.length > 0 ? ci.modifiers.map(m => m.id) : undefined,
      }));

      const result = await placeCustomerOrder(items, tableNumber);
      setOrderId(result.order_id);
      setOrderSecret(result.order_secret);
      saveActiveOrder(result.order_id, result.order_secret);
      dispatch({ type: 'CLEAR' });
      setCartOpen(false);
      setStage('tracking');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cart.placeOrderError'));
    } finally {
      setSubmitting(false);
    }
  }, [cart, tableNumber, t]);

  // Handle category click with manual scroll
  const handleCategoryClick = useCallback((catId: number) => {
    setActiveCategory(catId);
    isManualScroll.current = true;
    const el = categoryRefs.current.get(catId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => { isManualScroll.current = false; }, 1000);
    }
  }, []);

  // Format price
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  /* ==================== Tracking Stage ==================== */
  if (stage === 'tracking' && orderId && orderSecret) {
    return (
      <OrderStatusTracker
        orderId={orderId}
        orderSecret={orderSecret}
        onNewOrder={() => {
          setOrderId(null);
          setOrderSecret(null);
          setStage('menu');
          setLoading(true);
        }}
      />
    );
  }

  /* ==================== Loading / Error ==================== */
  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-brand-500 animate-spin" />
      </div>
    );
  }

  if (error && brands.length === 0) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-6">
        <div className="text-center">
          <p className="text-cockpit-out-text mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-brand-400 underline"
          >
            {t('menu.tryAgain')}
          </button>
        </div>
      </div>
    );
  }

  /* ==================== Main Menu ==================== */
  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col max-w-lg mx-auto relative">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-neutral-900 border-b border-neutral-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {branding?.logoUrl && (
            <img src={branding.logoUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
          )}
          <h1 className="text-lg font-bold text-white truncate">{brandName}</h1>
        </div>
        {cartItemCount > 0 && (
          <button
            onClick={() => setCartOpen(true)}
            className="relative bg-brand-600 text-white p-2.5 rounded-xl"
          >
            <ShoppingCart size={20} />
            <span className="absolute -top-1.5 -right-1.5 bg-white text-brand-700 text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center">
              {cartItemCount}
            </span>
          </button>
        )}
      </header>

      {/* Category pills */}
      <div
        ref={categoryScrollRef}
        className="sticky top-[57px] z-20 bg-neutral-950 border-b border-neutral-800 overflow-x-auto flex gap-2 px-4 py-3 scrollbar-hide"
      >
        {allCategories.map(cat => (
          <button
            key={cat.id}
            ref={activeCategory === cat.id ? activePillRef : undefined}
            onClick={() => handleCategoryClick(cat.id)}
            className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm font-medium transition-colors flex-shrink-0 ${
              activeCategory === cat.id
                ? 'bg-brand-600 text-white'
                : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
            }`}
          >
            {cat.name}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mt-3 px-4 py-2 bg-cockpit-red/20 border border-cockpit-red/50 rounded-lg text-cockpit-out-text text-sm">
          {error}
        </div>
      )}

      {/* Menu items — all categories rendered for scroll-spy */}
      <div className="flex-1 p-4 space-y-6 pb-24">
        {allCategories.map(cat => (
          <div
            key={cat.id}
            ref={el => { if (el) categoryRefs.current.set(cat.id, el); }}
            data-cat-id={cat.id}
          >
            <h2 className="text-lg font-bold text-white mb-3 sticky top-[110px] bg-neutral-950 py-1 z-10">
              {cat.name}
            </h2>
            <div className="space-y-3">
              {cat.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => openItem(item)}
                  className="w-full bg-neutral-900 border border-neutral-800 rounded-xl p-4 flex gap-4 text-left hover:border-neutral-700 transition-colors active:scale-[0.98]"
                >
                  {item.image_url && (
                    <img
                      src={item.image_url}
                      alt={item.name}
                      className="w-20 h-20 rounded-lg object-cover flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="text-white font-semibold truncate">{item.name}</h3>
                    {item.description && (
                      <p className="text-neutral-500 text-sm line-clamp-2 mt-0.5">{item.description}</p>
                    )}
                    <p className="text-brand-400 font-bold mt-1.5">{fmt(item.price)}</p>
                  </div>
                  <div className="flex items-center">
                    <div className="w-8 h-8 rounded-full bg-brand-600/20 text-brand-400 flex items-center justify-center">
                      <Plus size={18} />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}

        {allCategories.length === 0 && (
          <p className="text-neutral-600 text-center py-12">{t('menu.empty')}</p>
        )}
      </div>

      {/* Floating cart bar */}
      {cartItemCount > 0 && !cartOpen && (
        <div className="fixed bottom-0 left-0 right-0 z-30 p-4 max-w-lg mx-auto">
          <button
            onClick={() => setCartOpen(true)}
            className="w-full bg-brand-600 hover:bg-brand-700 text-white font-bold py-4 px-6 rounded-xl flex items-center justify-between transition-colors shadow-lg shadow-brand-600/20"
          >
            <span className="flex items-center gap-2">
              <ShoppingCart size={20} />
              <span>{t('cart.itemCount', { count: cartItemCount })}</span>
            </span>
            <span>{fmt(cartTotal)}</span>
          </button>
        </div>
      )}

      {/* Item Detail Modal */}
      {selectedItem && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedItem(null); }}
        >
          <div className="bg-neutral-900 w-full max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[85vh] flex flex-col animate-slide-up">
            {/* Modal header */}
            <div className="flex items-center justify-between p-4 border-b border-neutral-800">
              <h2 className="text-lg font-bold text-white truncate pr-4">{selectedItem.name}</h2>
              <button
                onClick={() => setSelectedItem(null)}
                className="text-neutral-500 hover:text-white p-1"
              >
                <X size={24} />
              </button>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {selectedItem.image_url && (
                <img
                  src={selectedItem.image_url}
                  alt={selectedItem.name}
                  className="w-full h-48 object-cover rounded-xl"
                />
              )}

              {selectedItem.description && (
                <p className="text-neutral-400 text-sm">{selectedItem.description}</p>
              )}

              <p className="text-brand-400 text-xl font-bold">{fmt(selectedItem.price)}</p>

              {/* Modifier groups */}
              {loadingModifiers && (
                <div className="flex justify-center py-4">
                  <Loader2 className="w-6 h-6 text-brand-500 animate-spin" />
                </div>
              )}

              {modifierGroups.map(group => (
                <div key={group.id} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white">{group.name}</h3>
                    {group.required && (
                      <span className="text-xs bg-brand-600/20 text-brand-400 px-2 py-0.5 rounded-full">
                        {t('item.required')}
                      </span>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    {group.modifiers?.map(mod => {
                      const isSelected = (selectedModifiers[group.id] || []).includes(mod.id);
                      return (
                        <button
                          key={mod.id}
                          onClick={() => toggleModifier(group.id, mod.id, group.selection_type, group.max_selections)}
                          className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors ${
                            isSelected
                              ? 'border-brand-500 bg-brand-600/10'
                              : 'border-neutral-700 bg-neutral-800 hover:border-neutral-600'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`w-5 h-5 rounded-${group.selection_type === 'single' ? 'full' : 'md'} border-2 flex items-center justify-center ${
                              isSelected ? 'border-brand-500 bg-brand-600' : 'border-neutral-600'
                            }`}>
                              {isSelected && <Check size={12} className="text-white" />}
                            </div>
                            <span className="text-sm text-white">{mod.name}</span>
                          </div>
                          {mod.price_adjustment > 0 && (
                            <span className="text-xs text-neutral-400">+{fmt(mod.price_adjustment)}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Notes */}
              <div>
                <label className="text-sm text-neutral-500 block mb-1">{t('item.specialInstructions')}</label>
                <textarea
                  value={itemNotes}
                  onChange={e => setItemNotes(e.target.value)}
                  maxLength={500}
                  rows={2}
                  placeholder={t('item.notesPlaceholder')}
                  className="w-full bg-neutral-800 border border-neutral-700 rounded-lg px-3 py-2 text-white text-sm placeholder-neutral-600 focus:outline-none focus:border-brand-500 resize-none"
                />
              </div>
            </div>

            {/* Modal footer */}
            <div className="p-4 border-t border-neutral-800">
              {/* Quantity selector */}
              <div className="flex items-center justify-center gap-4 mb-4">
                <button
                  onClick={() => setItemQty(q => Math.max(1, q - 1))}
                  className="w-10 h-10 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center text-white hover:bg-neutral-700"
                >
                  <Minus size={18} />
                </button>
                <span className="text-xl font-bold text-white w-8 text-center">{itemQty}</span>
                <button
                  onClick={() => setItemQty(q => Math.min(99, q + 1))}
                  className="w-10 h-10 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center text-white hover:bg-neutral-700"
                >
                  <Plus size={18} />
                </button>
              </div>

              <button
                onClick={addToCart}
                className="w-full bg-brand-600 hover:bg-brand-700 text-white font-bold py-3.5 rounded-xl transition-colors flex items-center justify-center gap-2 active:scale-[0.98]"
              >
                <Plus size={18} />
                {t('item.addToCart')} — {fmt(
                  (selectedItem.price +
                    Object.values(selectedModifiers)
                      .flat()
                      .reduce((sum, modId) => {
                        for (const g of modifierGroups) {
                          const mod = g.modifiers?.find(m => m.id === modId);
                          if (mod) return sum + mod.price_adjustment;
                        }
                        return sum;
                      }, 0)
                  ) * itemQty
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cart Sheet */}
      {cartOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center"
          onClick={(e) => { if (e.target === e.currentTarget) setCartOpen(false); }}
        >
          <div className="bg-neutral-900 w-full max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[85vh] flex flex-col animate-slide-up">
            {/* Cart header */}
            <div className="flex items-center justify-between p-4 border-b border-neutral-800">
              <h2 className="text-lg font-bold text-white">{t('cart.title')}</h2>
              <button
                onClick={() => setCartOpen(false)}
                className="text-neutral-500 hover:text-white p-1"
              >
                <X size={24} />
              </button>
            </div>

            {/* Cart items */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {cart.length === 0 ? (
                <p className="text-neutral-500 text-center py-12">{t('cart.empty')}</p>
              ) : (
                cart.map(ci => {
                  const modTotal = ci.modifiers.reduce((s, m) => s + m.price_adjustment, 0);
                  const lineTotal = (ci.price + modTotal) * ci.quantity;
                  return (
                    <div
                      key={ci.cartId}
                      className="bg-neutral-800 rounded-xl p-4"
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="text-white font-medium">{ci.name}</h3>
                          {ci.modifiers.length > 0 && (
                            <p className="text-neutral-500 text-xs mt-0.5">
                              {ci.modifiers.map(m => m.name).join(', ')}
                            </p>
                          )}
                          {ci.notes && (
                            <p className="text-neutral-600 text-xs mt-0.5 italic">{ci.notes}</p>
                          )}
                        </div>
                        <button
                          onClick={() => dispatch({ type: 'REMOVE_ITEM', cartId: ci.cartId })}
                          className="text-neutral-600 hover:text-cockpit-out-text p-1 ml-2"
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => dispatch({ type: 'UPDATE_QTY', cartId: ci.cartId, quantity: ci.quantity - 1 })}
                            className="w-7 h-7 rounded-full bg-neutral-700 flex items-center justify-center text-white hover:bg-neutral-600"
                          >
                            <Minus size={14} />
                          </button>
                          <span className="text-white font-medium text-sm w-4 text-center">{ci.quantity}</span>
                          <button
                            onClick={() => dispatch({ type: 'UPDATE_QTY', cartId: ci.cartId, quantity: ci.quantity + 1 })}
                            className="w-7 h-7 rounded-full bg-neutral-700 flex items-center justify-center text-white hover:bg-neutral-600"
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                        <span className="text-white font-semibold">{fmt(lineTotal)}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Cart footer */}
            {cart.length > 0 && (
              <div className="p-4 border-t border-neutral-800 space-y-3">
                <div className="flex items-center justify-between text-lg">
                  <span className="text-neutral-400">{t('cart.total')}</span>
                  <span className="text-white font-bold">{fmt(cartTotal)}</span>
                </div>
                <button
                  onClick={handlePlaceOrder}
                  disabled={submitting}
                  className="w-full bg-brand-600 hover:bg-brand-700 disabled:bg-brand-800 disabled:opacity-50 text-white font-bold py-4 rounded-xl transition-colors flex items-center justify-center gap-2 active:scale-[0.98]"
                >
                  {submitting ? (
                    <>
                      <Loader2 size={18} className="animate-spin" />
                      {t('cart.sending')}
                    </>
                  ) : (
                    t('cart.sendToKitchen')
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* CSS for slide-up animation */}
      <style>{`
        @keyframes slide-up {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .animate-slide-up {
          animation: slide-up 0.3s ease-out;
        }
        .scrollbar-hide::-webkit-scrollbar { display: none; }
        .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}
