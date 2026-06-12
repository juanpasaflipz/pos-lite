import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import {
  createOrder,
  cashPayment,
  getModifierGroupsForItem,
  splitStart,
  addStampsForOrder,
  createOrderTemplate,
  getOrders,
  getOrder,
  getTodayOrderCount,
  getMyCashSummary,
  deleteOrder,
  conektaOxxoPayment,
  conektaSpeiPayment,
  getnetTokenize,
  getnetCharge,
  bookUberDirect,
} from '../api';
import {
  getCachedCategories,
  getCachedMenuItems,
  getCachedItemsWithModifiers,
  getCachedCategorySuggestedOrder,
  getCachedCombos,
  getCachedOrderTemplates,
  getCachedPosBrands,
} from '../lib/menuCache';
import { MenuCategory, MenuItem, CartItem, Order, AISuggestion, LoyaltyCustomer, ComboDefinition, OrderTemplate, VirtualBrand, Discount } from '../types';
import RefundModal from '../components/RefundModal';
import KioskHeldOrdersBanner from '../components/pos/KioskHeldOrdersBanner';
import type { KioskHeldOrder } from '../api';
import NotesModal from '../components/pos/NotesModal';
import DiscountModal from '../components/pos/DiscountModal';
import PaymentModal from '../components/pos/PaymentModal';
import OxxoReferenceModal from '../components/pos/OxxoReferenceModal';
import SpeiReferenceModal from '../components/pos/SpeiReferenceModal';
import ReceiptModal from '../components/pos/ReceiptModal';
import { formatPrice, TAX_RATE, TAX_LABEL } from '../utils/currency';
import { useAISuggestions } from '../hooks/useAISuggestions';
import { useDeliveryAlerts } from '../hooks/useDeliveryAlerts';
import AISuggestionBanner from '../components/AISuggestionBanner';
import DeliveryAlertBanner from '../components/DeliveryAlertBanner';
import SetupChecklistBanner from '../components/SetupChecklistBanner';
import ModifierModal from '../components/ModifierModal';
import ComboBuilder from '../components/ComboBuilder';
import SplitPaymentModal from '../components/SplitPaymentModal';
import CustomerLookupModal from '../components/CustomerLookupModal';
import BrandLogo from '../components/BrandLogo';
import { usePlan } from '../context/PlanContext';
import TrialBanner from '../components/TrialBanner';
import DemoBanner from '../components/DemoBanner';
import FinancingBanner from '../components/financing/FinancingBanner';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useDeviceType } from '../hooks/useDeviceType';
import { createOfflineOrder, toReceiptOrder } from '../lib/offlineOrderQueue';
import { offlineDb, ParkedCart } from '../lib/offlineDb';
import CategoryBar from '../components/CategoryBar';
import CartDrawer from '../components/CartDrawer';
import MiniCartButton from '../components/MiniCartButton';

// Sub-components
import CategorySidebar from '../components/pos/CategorySidebar';
import POSHeaderBar from '../components/pos/POSHeaderBar';
import MenuGrid from '../components/pos/MenuGrid';
import CartPanel from '../components/pos/CartPanel';
import DeliveryAddressModal, { type DeliveryDraft } from '../components/pos/DeliveryAddressModal';
import LiveOrdersStrip from '../components/pos/LiveOrdersStrip';
import QuickOrdersModal from '../components/pos/QuickOrdersModal';
import ParkedCartsModal from '../components/pos/ParkedCartsModal';

/* ==================== Toast Notification ==================== */

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

/* ==================== Main POS Screen ==================== */

const POSScreen: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { currentEmployee, logout, hasPermission } = useAuth();
  const { t } = useTranslation('pos');
  const { isOnline, pendingSyncCount } = useNetworkStatus();
  const { isTablet, isPortrait } = useDeviceType();
  const showDrawerCart = isTablet && isPortrait;
  const { plan, ownerEmail, isMpConnected, isConektaConfigured, isGetnetEnabled } = usePlan();

  // State Management
  const [cart, setCart] = useState<CartItem[]>([]);
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<number | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [notesItem, setNotesItem] = useState<CartItem | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [completedOrder, setCompletedOrder] = useState<Order | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null);
  const [showComboBuilder, setShowComboBuilder] = useState(false);
  const [showSplitPayment, setShowSplitPayment] = useState(false);
  const [itemModifierCache, setItemModifierCache] = useState<Record<number, boolean>>({});
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundOrderId, setRefundOrderId] = useState<number | null>(null);
  const [linkedCustomer, setLinkedCustomer] = useState<LoyaltyCustomer | null>(null);
  const [showCustomerLookup, setShowCustomerLookup] = useState(false);
  // Tracks whether we've already auto-prompted the loyalty modal for the current
  // cart cycle. Resets when the cart goes empty (cleared, paid, or parked).
  const [loyaltyPromptedThisCart, setLoyaltyPromptedThisCart] = useState(false);
  const [categorySuggestedOrder, setCategorySuggestedOrder] = useState<number[]>([]);
  // Bumped after a new order is created/charged, so the live-orders strip
  // refreshes immediately instead of waiting for its 8s poll tick.
  const [ordersRefreshKey, setOrdersRefreshKey] = useState(0);
  const [comboDefinitions, setComboDefinitions] = useState<ComboDefinition[]>([]);
  const [templates, setTemplates] = useState<OrderTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [posBrands, setPosBrands] = useState<VirtualBrand[]>([]);
  const [selectedBrand, setSelectedBrand] = useState<number | 'all'>('all');
  const [templateName, setTemplateName] = useState('');
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [parkedCarts, setParkedCarts] = useState<ParkedCart[]>([]);
  const [showParkedCarts, setShowParkedCarts] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [cartDiscount, setCartDiscount] = useState<Discount | null>(null);
  // Counter-service in MX defaults to take-away; cashier flips to "Aquí"
  // when the customer is going to eat in. Resets to to_go when cart clears.
  const [cartFulfillment, setCartFulfillment] = useState<'for_here' | 'to_go' | 'delivery'>('to_go');
  // Uber Direct courier dispatch state — captured via DeliveryAddressModal when
  // cashier switches the toggle to "Delivery". Cleared whenever the cart clears.
  const [deliveryDraft, setDeliveryDraft] = useState<DeliveryDraft | null>(null);
  const [showDeliveryModal, setShowDeliveryModal] = useState(false);
  const [discountTarget, setDiscountTarget] = useState<{ scope: 'cart' } | { scope: 'item'; cartId: string } | null>(null);
  const [showNavMenu, setShowNavMenu] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Pre-created order for terminal payments (MP Point)
  const [preCreatedOrderId, setPreCreatedOrderId] = useState<number | null>(null);

  // Conekta async payment results
  const [oxxoResult, setOxxoResult] = useState<{ reference: string; barcode_url: string; amount: number; expires_at: string } | null>(null);
  const [speiResult, setSpeiResult] = useState<{ clabe: string; bank: string; amount: number; expires_at: string } | null>(null);

  // Unpaid orders (for Cobrar flow)
  const [unpaidOrders, setUnpaidOrders] = useState<Order[]>([]);
  const [todayOrderCount, setTodayOrderCount] = useState<number>(0);
  // Live cash-drawer total for header pill. null = no open shift / not yet loaded.
  const [cashDrawerExpected, setCashDrawerExpected] = useState<number | null>(null);
  const [showUnpaidOrders, setShowUnpaidOrders] = useState(false);
  // When set, the existing PaymentModal is repurposed to charge this order
  // (kiosk / QR / unpaid orders), bypassing the cart-creation path.
  const [chargingOrder, setChargingOrder] = useState<Order | null>(null);

  // AI Suggestions
  const cartItemIds = useMemo(() => cart.map((c) => c.menu_item_id), [cart]);
  const {
    cartSuggestions,
    pushItemIds,
    avoidItemIds,
    soldOutItemIds,
    lowStockItemIds,
    acceptSuggestion,
    dismissSuggestion,
  } = useAISuggestions({
    cartItemIds,
    employeeId: currentEmployee?.id,
    enabled: true,
  });

  // Delivery alerts
  const { alerts: deliveryAlerts, dismiss: dismissDeliveryAlert } = useDeliveryAlerts();

  const handleAcceptSuggestion = (suggestion: AISuggestion) => {
    const item = menuItems.find((mi) => mi.id === suggestion.data.suggested_item_id);
    if (item) {
      addItemToCartDirect(item);
      addToast(t('toast.itemAdded', { name: item.name }), 'success');
    }
    acceptSuggestion(suggestion);
  };

  // ==================== Effects ====================

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const fetchUnpaid = async () => {
      try {
        const orders = await getOrders({ payment_status: 'unpaid' });
        const relevant = orders.filter(
          (o) =>
            o.status === 'ready' ||
            o.status === 'completed' ||
            o.source === 'qr_order' ||
            o.source === 'customer_kiosk'
        );
        setUnpaidOrders(relevant);
      } catch {
        // non-blocking
      }
    };
    fetchUnpaid();
    const timer = setInterval(fetchUnpaid, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const count = await getTodayOrderCount();
        if (!cancelled) setTodayOrderCount(count);
      } catch {
        // non-blocking
      }
    };
    fetchCount();
    const timer = setInterval(fetchCount, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ordersRefreshKey]);

  // Live cash drawer total — refetched on every order pipeline change (cash
  // payment, refund, void) plus a 60s heartbeat in case admin clocked the
  // employee in/out from another device.
  useEffect(() => {
    let cancelled = false;
    const fetchDrawer = async () => {
      try {
        const summary = await getMyCashSummary();
        if (cancelled) return;
        setCashDrawerExpected(
          summary.has_open_shift && typeof summary.expected_cash_total === 'number'
            ? summary.expected_cash_total
            : null
        );
      } catch {
        // non-blocking
      }
    };
    fetchDrawer();
    const timer = setInterval(fetchDrawer, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ordersRefreshKey]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape' && searchQuery) {
        setSearchQuery('');
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery]);

  useEffect(() => {
    const loadData = async () => {
      try {
        setLoading(true);
        const [categoriesData, itemsData, modifierItemsData, categoryOrderData, combosData, templatesData, brandsData] = await Promise.all([
          getCachedCategories(),
          getCachedMenuItems(),
          getCachedItemsWithModifiers().catch(() => ({ itemIds: [] })),
          getCachedCategorySuggestedOrder().catch(() => []),
          getCachedCombos().catch(() => []),
          getCachedOrderTemplates().catch(() => []),
          getCachedPosBrands().catch(() => []),
        ]);
        setCategories(categoriesData);
        setMenuItems(itemsData);
        const cache: Record<number, boolean> = {};
        for (const id of modifierItemsData.itemIds) {
          cache[id] = true;
        }
        setItemModifierCache(cache);
        setCategorySuggestedOrder(categoryOrderData);
        setComboDefinitions(combosData);
        setTemplates(templatesData);
        setPosBrands(brandsData);
        if (categoryOrderData.length > 0) {
          setSelectedCategory(categoryOrderData[0]);
        }
      } catch (error) {
        addToast(t('toast.failedLoadMenu'), 'error');
      } finally {
        setLoading(false);
      }
    };
    loadData();
    offlineDb.cart.get(1).then((saved) => {
      if (saved && saved.items.length > 0) {
        setCart(saved.items);
      }
    }).catch(() => {});
    offlineDb.parkedCarts.orderBy('parkedAt').reverse().toArray()
      .then(setParkedCarts)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (cart.length > 0) {
        offlineDb.cart.put({ id: 1, items: cart, updatedAt: Date.now() }).catch(() => {});
      } else {
        offlineDb.cart.delete(1).catch(() => {});
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [cart]);

  // Auto-open the loyalty modal once per cart cycle when an order starts.
  // Skipped if a customer is already linked, the modal is already open, or the
  // cashier has dismissed it for this cart. Resets when the cart goes empty.
  useEffect(() => {
    if (cart.length === 0) {
      if (loyaltyPromptedThisCart) setLoyaltyPromptedThisCart(false);
      return;
    }
    if (loyaltyPromptedThisCart) return;
    if (linkedCustomer) return;
    if (showCustomerLookup) return;
    setShowCustomerLookup(true);
    setLoyaltyPromptedThisCart(true);
  }, [cart.length, linkedCustomer, showCustomerLookup, loyaltyPromptedThisCart]);

  // ==================== Helpers ====================

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  };

  const generateCartId = () => `cart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Force the live-orders strip to refetch on its next render — used after
  // any flow that mutates the order pipeline so the cashier sees the change
  // immediately instead of waiting up to 8s for the next poll.
  const bumpOrders = () => setOrdersRefreshKey((k) => k + 1);

  // ==================== Derived Data ====================

  const sortedCategories = useMemo(() => {
    if (categorySuggestedOrder.length === 0) return categories;
    const orderMap = new Map(categorySuggestedOrder.map((id, idx) => [id, idx]));
    return [...categories].sort((a, b) => {
      const aOrder = orderMap.get(a.id) ?? 999;
      const bOrder = orderMap.get(b.id) ?? 999;
      return aOrder - bOrder;
    });
  }, [categories, categorySuggestedOrder]);

  const comboSuggestion = useMemo(() => {
    if (cart.length === 0 || comboDefinitions.length === 0) return null;
    const nonComboItems = cart.filter(ci => !ci.combo_instance_id);
    if (nonComboItems.length === 0) return null;

    for (const combo of comboDefinitions) {
      if (!combo.active || !combo.slots || combo.slots.length === 0) continue;
      const matchedItems: CartItem[] = [];
      const usedCartIds = new Set<string>();
      let allSlotsMatched = true;

      for (const slot of combo.slots) {
        let found = false;
        for (const ci of nonComboItems) {
          if (usedCartIds.has(ci.cart_id)) continue;
          const menuItem = ci.menuItem || menuItems.find(mi => mi.id === ci.menu_item_id);
          if (!menuItem) continue;
          if (slot.specific_item_id && menuItem.id === slot.specific_item_id) {
            matchedItems.push(ci);
            usedCartIds.add(ci.cart_id);
            found = true;
            break;
          }
          if (slot.category_id && menuItem.category_id === slot.category_id) {
            matchedItems.push(ci);
            usedCartIds.add(ci.cart_id);
            found = true;
            break;
          }
        }
        if (!found) { allSlotsMatched = false; break; }
      }

      if (allSlotsMatched) {
        const individualTotal = matchedItems.reduce((sum, ci) => sum + ci.unit_price, 0);
        const savings = individualTotal - combo.combo_price;
        if (savings > 0) return { combo, matchedItems, savings };
      }
    }
    return null;
  }, [cart, comboDefinitions, menuItems]);

  const activeBrand = useMemo(() => {
    if (selectedBrand === 'all') return null;
    return posBrands.find(b => b.id === selectedBrand) || null;
  }, [selectedBrand, posBrands]);

  const brandItemMap = useMemo(() => {
    if (!activeBrand) return null;
    const map = new Map<number, { custom_name: string | null; custom_price: number | null }>();
    for (const bi of activeBrand.items) {
      map.set(bi.menu_item_id, { custom_name: bi.custom_name, custom_price: bi.custom_price });
    }
    return map;
  }, [activeBrand]);

  const filteredItems = useMemo(() => {
    let items = menuItems;
    if (brandItemMap) {
      items = items.filter((item) => brandItemMap.has(item.id));
    }
    if (selectedCategory !== 'all') {
      items = items.filter((item) => item.category_id === selectedCategory);
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      items = items.filter((item) => {
        const displayName = brandItemMap?.get(item.id)?.custom_name || item.name;
        return (
          displayName.toLowerCase().includes(query) ||
          item.name.toLowerCase().includes(query) ||
          item.description?.toLowerCase().includes(query)
        );
      });
    }
    return items;
  }, [menuItems, selectedCategory, searchQuery, brandItemMap]);

  const visibleCategories = useMemo(() => {
    if (!brandItemMap) return sortedCategories;
    const categoryIdsWithItems = new Set(
      menuItems.filter(item => brandItemMap.has(item.id)).map(item => item.category_id)
    );
    return sortedCategories.filter(cat => categoryIdsWithItems.has(cat.id));
  }, [sortedCategories, brandItemMap, menuItems]);

  const lineDiscountAmount = (item: CartItem): number => {
    if (!item.discount) return 0;
    const base = item.unit_price * item.quantity;
    if (item.discount.type === 'comp') return base;
    if (item.discount.type === 'percent') {
      const pct = Math.max(0, Math.min(100, Number(item.discount.value) || 0));
      return Math.round(base * (pct / 100) * 100) / 100;
    }
    return Math.min(base, Math.max(0, Math.round((Number(item.discount.value) || 0) * 100) / 100));
  };

  const grossTotal = parseFloat(
    cart.reduce((sum, item) => sum + item.unit_price * item.quantity - lineDiscountAmount(item), 0).toFixed(2)
  );

  const cartDiscountAmount = (() => {
    if (!cartDiscount) return 0;
    if (cartDiscount.type === 'comp') return grossTotal;
    if (cartDiscount.type === 'percent') {
      const pct = Math.max(0, Math.min(100, Number(cartDiscount.value) || 0));
      return Math.round(grossTotal * (pct / 100) * 100) / 100;
    }
    return Math.min(grossTotal, Math.max(0, Math.round((Number(cartDiscount.value) || 0) * 100) / 100));
  })();

  const total = parseFloat(Math.max(0, grossTotal - cartDiscountAmount).toFixed(2));
  const tax = parseFloat((total - total / (1 + TAX_RATE)).toFixed(2));
  const subtotal = parseFloat((total - tax).toFixed(2));
  const totalDiscount = parseFloat(
    (cart.reduce((sum, item) => sum + lineDiscountAmount(item), 0) + cartDiscountAmount).toFixed(2)
  );

  // ==================== Cart Operations ====================

  const addItemToCartDirect = (item: MenuItem) => {
    const brandOverride = brandItemMap?.get(item.id);
    const displayName = brandOverride?.custom_name || item.name;
    const displayPrice = brandOverride?.custom_price ?? item.price;
    const brandId = selectedBrand !== 'all' ? selectedBrand : null;

    setCart((prev) => {
      const existing = prev.find(
        (ci) => ci.menu_item_id === item.id && !ci.selectedModifierIds?.length && !ci.combo_instance_id && ci.virtual_brand_id === brandId
      );
      if (existing) {
        return prev.map((ci) =>
          ci.cart_id === existing.cart_id ? { ...ci, quantity: ci.quantity + 1 } : ci
        );
      }
      return [
        ...prev,
        {
          cart_id: generateCartId(),
          menu_item_id: item.id,
          item_name: displayName,
          quantity: 1,
          unit_price: Number(displayPrice),
          menuItem: item,
          virtual_brand_id: brandId,
        },
      ];
    });
  };

  const addItemWithModifiers = (item: MenuItem, selectedModifiers: number[], notes: string, modifierNames: string[], modifierPriceTotal: number) => {
    const brandOverride = brandItemMap?.get(item.id);
    const displayName = brandOverride?.custom_name || item.name;
    const displayPrice = brandOverride?.custom_price ?? item.price;
    const brandId = selectedBrand !== 'all' ? selectedBrand : null;

    setCart((prev) => [
      ...prev,
      {
        cart_id: generateCartId(),
        menu_item_id: item.id,
        item_name: displayName,
        quantity: 1,
        unit_price: Number(displayPrice) + modifierPriceTotal,
        menuItem: item,
        notes: notes || undefined,
        selectedModifierIds: selectedModifiers,
        selectedModifierNames: modifierNames,
        virtual_brand_id: brandId,
      },
    ]);
  };

  const handleItemTap = (item: MenuItem) => {
    if (soldOutItemIds.has(item.id)) return;
    if (itemModifierCache[item.id]) {
      setModifierItem(item);
    } else {
      addItemToCartDirect(item);
    }
  };

  const handleAddCombo = (items: Array<{ menu_item_id: number; combo_instance_id: string }>, comboPrice: number) => {
    const comboItems: CartItem[] = items.map((ci, idx) => {
      const menuItem = menuItems.find((mi) => mi.id === ci.menu_item_id);
      return {
        cart_id: generateCartId(),
        menu_item_id: ci.menu_item_id,
        item_name: menuItem?.name || `Combo Item ${idx + 1}`,
        quantity: 1,
        unit_price: idx === 0 ? comboPrice : 0,
        menuItem,
        combo_instance_id: ci.combo_instance_id,
      };
    });
    setCart((prev) => [...prev, ...comboItems]);
    setShowComboBuilder(false);
    addToast(t('toast.comboAdded'), 'success');
  };

  const removeFromCart = (cartId: string) => {
    setCart((prev) => {
      const item = prev.find((ci) => ci.cart_id === cartId);
      if (item?.combo_instance_id) {
        return prev.filter((ci) => ci.combo_instance_id !== item.combo_instance_id);
      }
      return prev.filter((ci) => ci.cart_id !== cartId);
    });
  };

  const updateQuantity = (cartId: string, quantity: number) => {
    if (quantity <= 0) {
      removeFromCart(cartId);
    } else {
      setCart((prev) =>
        prev.map((item) =>
          item.cart_id === cartId ? { ...item, quantity } : item
        )
      );
    }
  };

  const updateNotes = (cartId: string, notes: string) => {
    setCart((prev) =>
      prev.map((item) =>
        item.cart_id === cartId ? { ...item, notes } : item
      )
    );
  };

  const clearCart = () => {
    setCart([]);
    setLinkedCustomer(null);
    setCartDiscount(null);
    setCartFulfillment('to_go');
    setDeliveryDraft(null);
  };

  // Switching to delivery prompts the modal if no draft exists yet. Switching
  // away from delivery clears the draft so a stale quote can't leak into a
  // dine-in / takeout order.
  const handleFulfillmentChange = (next: 'for_here' | 'to_go' | 'delivery') => {
    setCartFulfillment(next);
    if (next === 'delivery' && !deliveryDraft) {
      setShowDeliveryModal(true);
    }
    if (next !== 'delivery' && deliveryDraft) {
      setDeliveryDraft(null);
    }
  };

  // Dispatches an Uber Direct courier for an order that was just created with
  // delivery fulfillment. Failure surfaces as a toast but does NOT throw — the
  // order is real and the courier can be dispatched manually from the Delivery
  // screen using the existing /api/uber-direct/deliveries route.
  const dispatchCourierIfDelivery = async (orderId: number) => {
    if (cartFulfillment !== 'delivery' || !deliveryDraft) return;
    try {
      const manifestItems = cart.map((item) => ({
        name: item.item_name,
        quantity: item.quantity,
        price: Math.round(Number(item.unit_price) * 100),
      }));
      await bookUberDirect({
        order_id: orderId,
        quote_id: deliveryDraft.quoteId,
        dropoff_name: deliveryDraft.customerName,
        dropoff_address: deliveryDraft.address,
        dropoff_phone_number: deliveryDraft.phone,
        dropoff_notes: deliveryDraft.notes || undefined,
        manifest_items: manifestItems,
        manifest_total_value: Math.round(total * 100),
        external_id: String(orderId),
      });
      addToast(t('delivery.dispatched', { eta: deliveryDraft.etaMin }), 'success');
    } catch (err) {
      addToast(
        err instanceof Error
          ? t('delivery.dispatchFailed', { reason: err.message })
          : t('delivery.dispatchFailed', { reason: 'Unknown' }),
        'error',
      );
    }
  };

  // All checkout paths funnel through this so courier dispatch is one line of
  // call-site change. createOrder shape is identical across every caller.
  const createOrderForCheckout = async () => {
    const order = await createOrder({
      employee_id: currentEmployee!.id,
      items: buildOrderItems(),
      discount: buildCartDiscountPayload(),
      order_fulfillment_type: cartFulfillment,
    });
    await dispatchCourierIfDelivery(order.id);
    return order;
  };

  const handleClaimKioskOrder = (order: KioskHeldOrder) => {
    const claimed: CartItem[] = order.items.map((item) => ({
      cart_id: generateCartId(),
      menu_item_id: item.menu_item_id,
      item_name: item.item_name,
      quantity: item.quantity,
      unit_price: Number(item.unit_price),
    }));
    setCart(claimed);
    setCartDiscount(null);
    if (order.loyalty_customer_id && order.customer_name && order.customer_phone) {
      setLinkedCustomer({
        id: order.loyalty_customer_id,
        phone: order.customer_phone,
        name: order.customer_name,
        referral_code: '',
        referred_by: null,
        store_id: 1,
        stamps_earned: 0,
        orders_count: 0,
        total_spent: 0,
      } as LoyaltyCustomer);
    }
    addToast(`Orden #${order.order_number} cargada del kiosko`, 'success');
  };

  const applyLineDiscount = (cartId: string, discount: Discount | null) => {
    setCart((prev) => prev.map((ci) => (ci.cart_id === cartId ? { ...ci, discount } : ci)));
  };

  const convertToCombo = useCallback(() => {
    if (!comboSuggestion) return;
    const { combo, matchedItems } = comboSuggestion;
    const comboInstanceId = `combo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    setCart(prev => {
      const matchedIds = new Set(matchedItems.map(ci => ci.cart_id));
      const remaining = prev.filter(ci => !matchedIds.has(ci.cart_id));
      const comboCartItems: CartItem[] = matchedItems.map((ci, idx) => ({
        ...ci,
        cart_id: generateCartId(),
        unit_price: idx === 0 ? combo.combo_price : 0,
        combo_instance_id: comboInstanceId,
      }));
      return [...remaining, ...comboCartItems];
    });
    addToast(t('comboDetection.converted', { name: combo.name }), 'success');
  }, [comboSuggestion]);

  const applyTemplate = useCallback((template: OrderTemplate) => {
    for (const item of template.items) {
      const menuItem = menuItems.find(mi => mi.id === item.menu_item_id);
      if (menuItem) {
        for (let i = 0; i < (item.quantity || 1); i++) {
          addItemToCartDirect(menuItem);
        }
      }
    }
    setShowTemplates(false);
    addToast(t('quickOrders.applied', { name: template.name }), 'success');
  }, [menuItems]);

  const saveCartAsTemplate = useCallback(async () => {
    if (!templateName.trim() || cart.length === 0) return;
    try {
      const items = cart
        .filter(ci => !ci.combo_instance_id)
        .map(ci => ({ menu_item_id: ci.menu_item_id, quantity: ci.quantity }));
      const newTemplate = await createOrderTemplate({ name: templateName.trim(), items });
      setTemplates(prev => [...prev, newTemplate]);
      setTemplateName('');
      setShowSaveTemplate(false);
      addToast(t('quickOrders.saved', { name: templateName.trim() }), 'success');
    } catch {
      addToast(t('toast.failedSaveTemplate'), 'error');
    }
  }, [templateName, cart]);

  const parkCurrentOrder = useCallback(async (name: string) => {
    if (cart.length === 0) return;
    try {
      const id = await offlineDb.parkedCarts.add({
        name,
        items: cart,
        parkedAt: Date.now(),
      });
      const fresh = await offlineDb.parkedCarts.orderBy('parkedAt').reverse().toArray();
      setParkedCarts(fresh);
      setCart([]);
      setLinkedCustomer(null);
      setShowParkedCarts(false);
      addToast(t('parkedCarts.parked', { name }), 'success');
      void id;
    } catch {
      addToast(t('parkedCarts.parkFailed'), 'error');
    }
  }, [cart, t]);

  const resumeParkedCart = useCallback(async (id: number) => {
    if (cart.length > 0 && !window.confirm(t('parkedCarts.confirmReplace'))) return;
    try {
      const parked = await offlineDb.parkedCarts.get(id);
      if (!parked) return;
      setCart(parked.items);
      await offlineDb.parkedCarts.delete(id);
      const fresh = await offlineDb.parkedCarts.orderBy('parkedAt').reverse().toArray();
      setParkedCarts(fresh);
      setShowParkedCarts(false);
      addToast(t('parkedCarts.resumed', { name: parked.name }), 'success');
    } catch {
      addToast(t('parkedCarts.resumeFailed'), 'error');
    }
  }, [cart, t]);

  const deleteParkedCart = useCallback(async (id: number) => {
    try {
      await offlineDb.parkedCarts.delete(id);
      const fresh = await offlineDb.parkedCarts.orderBy('parkedAt').reverse().toArray();
      setParkedCarts(fresh);
    } catch {
      addToast(t('parkedCarts.deleteFailed'), 'error');
    }
  }, [t]);

  // ==================== Payment Handlers ====================

  const handleLoyaltyStamp = async (order: Order) => {
    if (!linkedCustomer) return;
    try {
      const result = await addStampsForOrder(linkedCustomer.id, order.id);
      if (result.cardCompleted) {
        addToast(t('loyalty.cardCompleted', { name: linkedCustomer.name }), 'success');
      } else {
        addToast(
          t('loyalty.stampAdded', { name: linkedCustomer.name, earned: result.stampCard.stamps_earned, required: result.stampCard.stamps_required }),
          'success'
        );
      }
    } catch {
      // Non-blocking: payment already succeeded
    }
    // NOTE: do not clear linkedCustomer here — ReceiptModal still needs it to
    // prefill the SMS receipt form. Cleared in onClose of the receipt modal.
  };

  const buildOrderItems = () => cart.map((item) => ({
    menu_item_id: item.menu_item_id,
    quantity: item.quantity,
    notes: item.notes,
    modifiers: item.selectedModifierIds || [],
    combo_instance_id: item.combo_instance_id || null,
    virtual_brand_id: item.virtual_brand_id || null,
    discount: item.discount
      ? {
          type: item.discount.type,
          value: item.discount.value,
          reason: item.discount.reason,
          authorized_by_employee_id: item.discount.authorized_by_employee_id,
        }
      : null,
  }));

  const buildCartDiscountPayload = () => cartDiscount
    ? {
        type: cartDiscount.type,
        value: cartDiscount.value,
        reason: cartDiscount.reason,
        authorized_by_employee_id: cartDiscount.authorized_by_employee_id,
      }
    : null;

  // Send-to-kitchen — for dine-in tabs the customer hasn't paid yet but the
  // kitchen should start cooking. Mirrors the kiosk dine-in flow. The order
  // lands on the KDS as status='active', payment_status='unpaid' and the
  // cashier charges it later via the LiveOrdersStrip Cobrar button.
  const handleSendToKitchen = async () => {
    if (cart.length === 0) { addToast(t('toast.cartEmpty'), 'error'); return; }
    setIsProcessingPayment(true);
    try {
      const order = await createOrderForCheckout();
      clearCart();
      bumpOrders();
      addToast(t('toast.sentToKitchen', { number: order.order_number }), 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toast.sendToKitchenFailed'), 'error');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const openPaymentModal = async () => {
    if ((isMpConnected || isConektaConfigured) && cart.length > 0) {
      try {
        const order = await createOrderForCheckout();
        setPreCreatedOrderId(order.id);
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Error creating order', 'error');
        return;
      }
    } else {
      setPreCreatedOrderId(null);
    }
    setShowPaymentModal(true);
  };

  const handleCashPayment = async (tip: number, amountReceived: number) => {
    // Paying an existing order (kiosk/QR/unpaid drawer) — no cart, no create.
    if (chargingOrder) {
      setIsProcessingPayment(true);
      try {
        const result = await cashPayment({ order_id: chargingOrder.id, tip, amount_received: amountReceived });
        const paidOrder = await getOrder(chargingOrder.id);
        await handleLoyaltyStamp(paidOrder);
        setCompletedOrder(paidOrder);
        setUnpaidOrders((prev) => prev.filter((o) => o.id !== chargingOrder.id));
        setShowPaymentModal(false);
        setChargingOrder(null);
        setPreCreatedOrderId(null);
        setShowReceiptModal(true);
        bumpOrders();
        addToast(t('toast.cashDone', { change: formatPrice(result.change_due) }), 'success');
      } catch (error) {
        addToast(error instanceof Error ? error.message : t('toast.cashFailed'), 'error');
      } finally {
        setIsProcessingPayment(false);
      }
      return;
    }
    if (cart.length === 0 && !preCreatedOrderId) { addToast(t('toast.cartEmpty'), 'error'); return; }
    setIsProcessingPayment(true);
    try {
      if (!isOnline) {
        const offlineOrder = await createOfflineOrder(currentEmployee!.id, currentEmployee!.name, cart, tip, amountReceived);
        const receiptOrder = toReceiptOrder(offlineOrder);
        setCompletedOrder(receiptOrder);
        setShowPaymentModal(false);
        setShowReceiptModal(true);
        clearCart();
        addToast(t('offline.orderSaved', { number: offlineOrder.offlineOrderNumber }), 'success');
      } else {
        // Reuse the order openPaymentModal pre-created for the MP/Conekta
        // terminal flow — otherwise Cobrar → Cash on a terminal-enabled
        // tenant orphans the pre-created order and creates a duplicate.
        // Matches the pattern in handleOxxoPayment / handleSpeiPayment.
        const order = preCreatedOrderId
          ? await getOrder(preCreatedOrderId)
          : await createOrderForCheckout();
        const result = await cashPayment({ order_id: order.id, tip, amount_received: amountReceived });
        const finalOrder: Order = { ...order, tip, total: Number(order.total) + tip, payment_method: 'cash', employee_name: currentEmployee?.name, estimated_ready_minutes: order.estimated_ready_minutes, estimated_ready_range: order.estimated_ready_range };
        await handleLoyaltyStamp(order);
        setCompletedOrder(finalOrder);
        setShowPaymentModal(false);
        setPreCreatedOrderId(null);
        setShowReceiptModal(true);
        clearCart();
        bumpOrders();
        addToast(t('toast.cashDone', { change: formatPrice(result.change_due) }), 'success');
      }
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toast.cashFailed'), 'error');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleOxxoPayment = async (tip: number) => {
    if (cart.length === 0 && !preCreatedOrderId) { addToast(t('toast.cartEmpty'), 'error'); return; }
    setIsProcessingPayment(true);
    try {
      const orderId = preCreatedOrderId || (await createOrderForCheckout()).id;
      const result = await conektaOxxoPayment({ order_id: orderId, tip });
      setOxxoResult({
        reference: result.reference,
        barcode_url: result.barcode_url,
        amount: result.amount,
        expires_at: result.expires_at,
      });
      setShowPaymentModal(false);
      setPreCreatedOrderId(null);
      if (chargingOrder) {
        setUnpaidOrders((prev) => prev.filter((o) => o.id !== chargingOrder.id));
        setChargingOrder(null);
      } else {
        clearCart();
      }
      bumpOrders();
      addToast(t('toast.oxxoGenerated'), 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toast.oxxoFailed'), 'error');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleSpeiPayment = async (tip: number) => {
    if (cart.length === 0 && !preCreatedOrderId) { addToast(t('toast.cartEmpty'), 'error'); return; }
    setIsProcessingPayment(true);
    try {
      const orderId = preCreatedOrderId || (await createOrderForCheckout()).id;
      const result = await conektaSpeiPayment({ order_id: orderId, tip });
      setSpeiResult({
        clabe: result.clabe,
        bank: result.bank,
        amount: result.amount,
        expires_at: result.expires_at,
      });
      setShowPaymentModal(false);
      setPreCreatedOrderId(null);
      if (chargingOrder) {
        setUnpaidOrders((prev) => prev.filter((o) => o.id !== chargingOrder.id));
        setChargingOrder(null);
      } else {
        clearCart();
      }
      bumpOrders();
      addToast(t('toast.speiGenerated'), 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toast.speiFailed'), 'error');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleGetnetPayment = async (tip: number) => {
    if (cart.length === 0 && !preCreatedOrderId) { addToast(t('toast.cartEmpty'), 'error'); return; }
    setIsProcessingPayment(true);
    try {
      const orderId = preCreatedOrderId || (await createOrderForCheckout()).id;
      // For Getnet card payments, the card tokenization happens on the server side
      // In a full implementation, the card form would collect and tokenize first
      // For now, this creates the order and marks it for Getnet processing
      addToast(t('toast.getnetReady'), 'info');
      setPreCreatedOrderId(orderId);
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toast.getnetFailed'), 'error');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  // Split flow keeps the order in scope so the modal can finalize and we can show the receipt.
  const splitOrderRef = useRef<Order | null>(null);

  const handleSplitStart = async (
    splits: Array<{ payment_method: 'card' | 'cash'; amount: number; tip: number }>,
  ) => {
    // Splitting an existing order (kiosk/QR/unpaid) reuses its id; the cart
    // path still pre-creates an order from the in-progress cart.
    let order: Order;
    if (chargingOrder) {
      order = chargingOrder;
    } else {
      if (cart.length === 0) {
        throw new Error(t('toast.cartEmpty'));
      }
      order = await createOrderForCheckout();
    }
    splitOrderRef.current = order;
    const result = await splitStart({
      order_id: order.id,
      splits: splits.map((s) => ({ payment_method: s.payment_method, amount: s.amount, tip: s.tip })),
    });
    return { orderId: order.id, splits: result.splits };
  };

  const handleSplitComplete = async (_orderId: number, totalTip: number) => {
    const order = splitOrderRef.current;
    const wasExisting = !!chargingOrder;
    splitOrderRef.current = null;
    if (!order) {
      // Defensive: modal finished but we lost the ref. Just close and refresh.
      setShowSplitPayment(false);
      if (!wasExisting) clearCart();
      setChargingOrder(null);
      addToast(t('toast.splitDone'), 'success');
      return;
    }
    try {
      await handleLoyaltyStamp(order);
    } catch {
      // Loyalty stamp failure shouldn't block the receipt.
    }
    const finalOrder: Order = {
      ...order,
      tip: totalTip,
      total: order.subtotal + order.tax + totalTip,
      payment_method: 'split',
      payment_status: 'paid',
      employee_name: currentEmployee?.name,
      estimated_ready_minutes: order.estimated_ready_minutes,
      estimated_ready_range: order.estimated_ready_range,
    };
    setCompletedOrder(finalOrder);
    setShowSplitPayment(false);
    setShowReceiptModal(true);
    if (wasExisting) {
      setUnpaidOrders((prev) => prev.filter((o) => o.id !== order.id));
      setChargingOrder(null);
    } else {
      clearCart();
    }
    bumpOrders();
    addToast(t('toast.splitDone'), 'success');
  };

  const handleSplitClose = () => {
    splitOrderRef.current = null;
    setShowSplitPayment(false);
    setChargingOrder(null);
  };

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  // Cobrar from the live-orders strip / unpaid drawer. Routes to the full
  // PaymentModal (MP terminal, Clip, cash w/ change, OXXO, SPEI) — same surface
  // the cart Cobrar uses — instead of the legacy mark-as-paid picker.
  const handleCobrar = async (order: Order) => {
    try {
      const fullOrder = await getOrder(order.id);
      setChargingOrder(fullOrder);
      setPreCreatedOrderId(fullOrder.id);
      setShowPaymentModal(true);
    } catch {
      addToast(t('toast.errorLoadingOrder'), 'error');
    }
  };

  // The /admin/orders screen hands the cashier an unpaid order to charge by
  // navigating here with { state: { chargeOrderId } }. We pick it up on mount,
  // open the payment flow, then clear the state so a refresh doesn't re-trigger.
  useEffect(() => {
    const state = location.state as { chargeOrderId?: number } | null;
    const id = state?.chargeOrderId;
    if (!id) return;
    handleCobrar({ id } as Order);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // ==================== Render ====================

  if (loading) {
    return (
      <div className="min-h-screen bg-neutral-950 flex items-center justify-center">
        <div className="text-center">
          <BrandLogo className="h-16 mx-auto mb-4" />
          <p className="text-xl font-bold text-white">{t('actions.loadingMenu')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex h-screen bg-neutral-950 overflow-hidden ${plan === 'free' ? 'pb-12' : ''}`}>
      {/* Left Sidebar - Categories */}
      <CategorySidebar
        categories={visibleCategories}
        selectedCategory={selectedCategory}
        onSelectCategory={(id) => { setSelectedCategory(id); setSearchQuery(''); }}
      />

      {/* Center Panel - Menu Items */}
      <div className="flex-1 flex flex-col bg-neutral-950 min-w-0">
        {showDrawerCart && (
          <CategoryBar
            categories={visibleCategories}
            selectedCategory={selectedCategory}
            onSelectCategory={(id) => { setSelectedCategory(id); setSearchQuery(''); }}
          />
        )}

        <POSHeaderBar
          currentEmployee={currentEmployee}
          plan={plan}
          ownerEmail={ownerEmail}
          currentTime={currentTime}
          isOnline={isOnline}
          pendingSyncCount={pendingSyncCount}
          searchQuery={searchQuery}
          searchInputRef={searchInputRef}
          posBrands={posBrands}
          selectedBrand={selectedBrand}
          showDrawerCart={showDrawerCart}
          showNavMenu={showNavMenu}
          todayOrderCount={todayOrderCount}
          cashDrawerExpected={cashDrawerExpected}
          filteredItemsCount={filteredItems.length}
          onSearchChange={setSearchQuery}
          onSelectBrand={setSelectedBrand}
          onSetSelectedCategory={setSelectedCategory}
          onToggleNavMenu={() => setShowNavMenu(!showNavMenu)}
          onCloseNavMenu={() => setShowNavMenu(false)}
          onLogout={handleLogout}
        />

        <DeliveryAlertBanner alerts={deliveryAlerts} onDismiss={dismissDeliveryAlert} />
        <TrialBanner />
        <DemoBanner />
        <FinancingBanner />

        {currentEmployee && ['admin', 'manager'].includes(currentEmployee.role) && (
          <SetupChecklistBanner />
        )}

        <KioskHeldOrdersBanner
          onClaim={handleClaimKioskOrder}
          onError={(msg) => addToast(msg, 'error')}
        />

        <AISuggestionBanner
          suggestions={cartSuggestions}
          onAccept={handleAcceptSuggestion}
          onDismiss={dismissSuggestion}
        />

        <LiveOrdersStrip
          onViewAll={() => navigate('/admin/orders')}
          onCharge={handleCobrar}
          onRefund={(orderId) => {
            setRefundOrderId(orderId);
            setShowRefundModal(true);
          }}
          refreshKey={ordersRefreshKey}
        />

        <MenuGrid
          filteredItems={filteredItems}
          brandItemMap={brandItemMap}
          itemModifierCache={itemModifierCache}
          soldOutItemIds={soldOutItemIds}
          pushItemIds={pushItemIds}
          avoidItemIds={avoidItemIds}
          lowStockItemIds={lowStockItemIds}
          onItemTap={handleItemTap}
          onAddToast={addToast}
        />
      </div>

      {/* Right Sidebar - Cart */}
      <CartPanel
        cart={cart}
        linkedCustomer={linkedCustomer}
        unpaidOrders={unpaidOrders}
        showUnpaidOrders={showUnpaidOrders}
        comboSuggestion={comboSuggestion}
        total={total}
        subtotal={subtotal}
        tax={tax}
        parkedCount={parkedCarts.length}
        cartDiscount={cartDiscount}
        totalDiscount={totalDiscount}
        onRemoveFromCart={removeFromCart}
        onUpdateQuantity={updateQuantity}
        onSetNotesItem={setNotesItem}
        onShowPaymentModal={openPaymentModal}
        onSendToKitchen={handleSendToKitchen}
        fulfillment={cartFulfillment}
        onFulfillmentChange={handleFulfillmentChange}
        deliveryDraft={deliveryDraft}
        onEditDelivery={() => setShowDeliveryModal(true)}
        onShowCustomerLookup={() => setShowCustomerLookup(true)}
        onShowTemplates={() => setShowTemplates(true)}
        onShowParkedCarts={() => setShowParkedCarts(true)}
        onShowComboBuilder={() => setShowComboBuilder(true)}
        onShowSplitPayment={() => setShowSplitPayment(true)}
        onClearCart={clearCart}
        onLogout={handleLogout}
        onConvertToCombo={convertToCombo}
        onCobrar={handleCobrar}
        onToggleUnpaidOrders={() => setShowUnpaidOrders(!showUnpaidOrders)}
        onUnlinkCustomer={() => setLinkedCustomer(null)}
        onApplyCartDiscount={() => setDiscountTarget({ scope: 'cart' })}
        onApplyLineDiscount={(item) => setDiscountTarget({ scope: 'item', cartId: item.cart_id })}
        onDeleteUnpaidOrder={async (order) => {
          if (!window.confirm(`Delete order #${order.order_number}? This cannot be undone.`)) return;
          try {
            await deleteOrder(order.id);
            setUnpaidOrders((prev) => prev.filter((o) => o.id !== order.id));
          } catch (err) {
            window.alert(err instanceof Error ? err.message : 'Failed to delete order');
          }
        }}
      />

      {/* Tablet Portrait: Cart Drawer + Mini Button */}
      {showDrawerCart && (
        <>
          <MiniCartButton count={cart.length} total={total} onClick={() => setIsCartOpen(true)} />
          <CartDrawer
            isOpen={isCartOpen}
            onClose={() => setIsCartOpen(false)}
            cart={cart}
            linkedCustomer={linkedCustomer}
            unpaidOrders={unpaidOrders}
            showUnpaidOrders={showUnpaidOrders}
            parkedCount={parkedCarts.length}
            onUnlinkCustomer={() => setLinkedCustomer(null)}
            onRemoveFromCart={removeFromCart}
            onUpdateQuantity={updateQuantity}
            onSetNotesItem={setNotesItem}
            onShowPaymentModal={openPaymentModal}
            onSendToKitchen={handleSendToKitchen}
            fulfillment={cartFulfillment}
            onFulfillmentChange={handleFulfillmentChange}
            onShowCustomerLookup={() => setShowCustomerLookup(true)}
            onShowTemplates={() => setShowTemplates(true)}
            onShowParkedCarts={() => setShowParkedCarts(true)}
            onShowComboBuilder={() => setShowComboBuilder(true)}
            onShowSplitPayment={() => setShowSplitPayment(true)}
            onClearCart={clearCart}
            onLogout={handleLogout}
            onCobrar={handleCobrar}
            onToggleUnpaidOrders={() => setShowUnpaidOrders(!showUnpaidOrders)}
            onDeleteUnpaidOrder={async (order) => {
              if (!window.confirm(`Delete order #${order.order_number}? This cannot be undone.`)) return;
              try {
                await deleteOrder(order.id);
                setUnpaidOrders((prev) => prev.filter((o) => o.id !== order.id));
              } catch (err) {
                window.alert(err instanceof Error ? err.message : 'Failed to delete order');
              }
            }}
            comboSuggestion={comboSuggestion}
            onConvertToCombo={convertToCombo}
            total={total}
            subtotal={subtotal}
            tax={tax}
            cartDiscount={cartDiscount}
            totalDiscount={totalDiscount}
            onApplyCartDiscount={() => setDiscountTarget({ scope: 'cart' })}
            onApplyLineDiscount={(item) => setDiscountTarget({ scope: 'item', cartId: item.cart_id })}
          />
        </>
      )}

      {/* ==================== MODALS ==================== */}

      {showTemplates && (
        <QuickOrdersModal
          templates={templates}
          hasCartItems={cart.length > 0}
          hasPermission={hasPermission('manage_menu')}
          showSaveTemplate={showSaveTemplate}
          templateName={templateName}
          onClose={() => setShowTemplates(false)}
          onApplyTemplate={applyTemplate}
          onSaveCartAsTemplate={saveCartAsTemplate}
          onTemplateNameChange={setTemplateName}
          onShowSaveTemplate={setShowSaveTemplate}
        />
      )}

      {showParkedCarts && (
        <ParkedCartsModal
          parkedCarts={parkedCarts}
          hasCartItems={cart.length > 0}
          onClose={() => setShowParkedCarts(false)}
          onParkCurrent={parkCurrentOrder}
          onResume={resumeParkedCart}
          onDelete={deleteParkedCart}
        />
      )}

      {showCustomerLookup && (
        <CustomerLookupModal
          onCustomerLinked={(customer) => {
            setLinkedCustomer(customer);
            setShowCustomerLookup(false);
            addToast(t('loyalty.linked', { name: customer.name }), 'success');
          }}
          onClose={() => setShowCustomerLookup(false)}
        />
      )}

      {notesItem && (
        <NotesModal
          item={notesItem}
          onSave={(notes) => {
            updateNotes(notesItem.cart_id, notes);
            setNotesItem(null);
          }}
          onClose={() => setNotesItem(null)}
        />
      )}

      {discountTarget && (() => {
        if (discountTarget.scope === 'cart') {
          return (
            <DiscountModal
              base={grossTotal}
              scope="cart"
              initialDiscount={cartDiscount}
              onSave={(discount) => {
                setCartDiscount(discount);
                setDiscountTarget(null);
              }}
              onClose={() => setDiscountTarget(null)}
            />
          );
        }
        const target = cart.find((ci) => ci.cart_id === discountTarget.cartId);
        if (!target) {
          setDiscountTarget(null);
          return null;
        }
        const lineBase = target.unit_price * target.quantity;
        return (
          <DiscountModal
            base={lineBase}
            scope="item"
            itemName={target.item_name}
            initialDiscount={target.discount || null}
            onSave={(discount) => {
              applyLineDiscount(target.cart_id, discount);
              setDiscountTarget(null);
            }}
            onClose={() => setDiscountTarget(null)}
          />
        );
      })()}

      {modifierItem && (
        <ModifierModal
          item={modifierItem}
          onConfirm={(selectedModifiers, notes) => {
            getModifierGroupsForItem(modifierItem.id).then((groups) => {
              const modNames: string[] = [];
              let modPriceTotal = 0;
              for (const g of groups) {
                for (const mod of g.modifiers || []) {
                  if (selectedModifiers.includes(mod.id)) {
                    modNames.push(mod.name);
                    modPriceTotal += Number(mod.price_adjustment) || 0;
                  }
                }
              }
              addItemWithModifiers(modifierItem, selectedModifiers, notes, modNames, modPriceTotal);
              setModifierItem(null);
            });
          }}
          onClose={() => setModifierItem(null)}
        />
      )}

      {showComboBuilder && (
        <ComboBuilder
          onAddCombo={handleAddCombo}
          onClose={() => setShowComboBuilder(false)}
        />
      )}

      {showSplitPayment && (
        <SplitPaymentModal
          orderTotal={chargingOrder ? Number(chargingOrder.total) : total}
          items={
            chargingOrder
              ? (chargingOrder.items || [])
                  .filter((it) => !it.voided_at)
                  .map((it) => ({
                    ...it,
                    cart_id: String(it.id ?? `oi-${it.item_name}-${it.quantity}`),
                  }))
              : cart
          }
          isMpConnected={isMpConnected}
          onStart={handleSplitStart}
          onComplete={handleSplitComplete}
          onClose={handleSplitClose}
        />
      )}

      <DeliveryAddressModal
        isOpen={showDeliveryModal}
        initial={deliveryDraft}
        manifestTotalValue={total || 0}
        onClose={() => {
          setShowDeliveryModal(false);
          // If the cashier cancels before saving a quote and there's no prior
          // draft, drop them back to to_go so the cart total doesn't show a
          // courier fee row that has no quote behind it.
          if (!deliveryDraft && cartFulfillment === 'delivery') {
            setCartFulfillment('to_go');
          }
        }}
        onSave={(draft) => {
          setDeliveryDraft(draft);
          setShowDeliveryModal(false);
        }}
      />

      {showPaymentModal && (
        <PaymentModal
          orderTotal={chargingOrder ? Number(chargingOrder.total) : total}
          orderId={preCreatedOrderId ?? undefined}
          onCashPayment={handleCashPayment}
          onOxxoPayment={handleOxxoPayment}
          onSpeiPayment={handleSpeiPayment}
          onGetnetPayment={handleGetnetPayment}
          onTerminalPaymentSuccess={async (orderId) => {
            try {
              const paidOrder = await getOrder(orderId);
              await handleLoyaltyStamp(paidOrder);
              setCompletedOrder(paidOrder);
              setShowReceiptModal(true);
            } catch {
              // Payment succeeded; receipt fetch is non-blocking.
            }
            if (chargingOrder) {
              setUnpaidOrders((prev) => prev.filter((o) => o.id !== orderId));
              setChargingOrder(null);
            } else {
              clearCart();
            }
            setShowPaymentModal(false);
            setPreCreatedOrderId(null);
            bumpOrders();
            addToast(t('toast.mpConfirmed'), 'success');
          }}
          onSplitPayment={
            chargingOrder
              ? () => {
                  setShowPaymentModal(false);
                  setPreCreatedOrderId(null);
                  setShowSplitPayment(true);
                }
              : undefined
          }
          onCancel={() => {
            setShowPaymentModal(false);
            setPreCreatedOrderId(null);
            setChargingOrder(null);
          }}
          isProcessing={isProcessingPayment}
          isOnline={isOnline}
          conektaConfigured={isConektaConfigured}
          getnetEnabled={isGetnetEnabled}
        />
      )}

      {showReceiptModal && completedOrder && (
        <ReceiptModal
          order={completedOrder}
          linkedCustomer={linkedCustomer}
          onClose={() => { setShowReceiptModal(false); setCompletedOrder(null); setLinkedCustomer(null); }}
          onPrint={() => { window.print(); }}
        />
      )}

      {oxxoResult && (
        <OxxoReferenceModal
          reference={oxxoResult.reference}
          barcodeUrl={oxxoResult.barcode_url}
          amount={oxxoResult.amount}
          expiresAt={oxxoResult.expires_at}
          onClose={() => setOxxoResult(null)}
        />
      )}

      {speiResult && (
        <SpeiReferenceModal
          clabe={speiResult.clabe}
          bank={speiResult.bank}
          amount={speiResult.amount}
          expiresAt={speiResult.expires_at}
          onClose={() => setSpeiResult(null)}
        />
      )}

      {showRefundModal && refundOrderId && (
        <RefundModal
          orderId={refundOrderId}
          onClose={() => { setShowRefundModal(false); setRefundOrderId(null); }}
          onRefunded={() => {
            setShowRefundModal(false);
            setRefundOrderId(null);
            bumpOrders();
            addToast(t('toast.refundDone'), 'success');
          }}
        />
      )}

      {/* Toast Notifications */}
      <div className={`fixed right-4 space-y-2 z-[60] pointer-events-none ${plan === 'free' ? 'bottom-16' : 'bottom-4'}`}>
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`px-6 py-3 rounded-lg text-white font-semibold shadow-lg pointer-events-auto ${
              toast.type === 'success' ? 'bg-green-600' : toast.type === 'error' ? 'bg-brand-600' : 'bg-neutral-700'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
};

export default POSScreen;
