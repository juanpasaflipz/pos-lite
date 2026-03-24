import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTranslation } from 'react-i18next';
import {
  createOrder,
  createPaymentIntent,
  confirmPayment,
  cashPayment,
  getModifierGroupsForItem,
  splitPayment,
  addStampsForOrder,
  createOrderTemplate,
  getOrders,
  getOrder,
  conektaOxxoPayment,
  conektaSpeiPayment,
  getnetTokenize,
  getnetCharge,
} from '../api';
import {
  getCachedCategories,
  getCachedMenuItems,
  getCachedItemsWithModifiers,
  getCachedPopularItems,
  getCachedCategorySuggestedOrder,
  getCachedCombos,
  getCachedOrderTemplates,
  getCachedPosBrands,
} from '../lib/menuCache';
import { MenuCategory, MenuItem, CartItem, Order, AISuggestion, LoyaltyCustomer, ComboDefinition, OrderTemplate, VirtualBrand } from '../types';
import RefundModal from '../components/RefundModal';
import NotesModal from '../components/pos/NotesModal';
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
import { offlineDb } from '../lib/offlineDb';
import CategoryBar from '../components/CategoryBar';
import CartDrawer from '../components/CartDrawer';
import MiniCartButton from '../components/MiniCartButton';
import PaymentConfirmationModal from '../components/PaymentConfirmationModal';

// Sub-components
import CategorySidebar from '../components/pos/CategorySidebar';
import POSHeaderBar from '../components/pos/POSHeaderBar';
import MenuGrid from '../components/pos/MenuGrid';
import CartPanel from '../components/pos/CartPanel';
import QuickOrdersModal from '../components/pos/QuickOrdersModal';

/* ==================== Toast Notification ==================== */

interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

/* ==================== Main POS Screen ==================== */

const POSScreen: React.FC = () => {
  const navigate = useNavigate();
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
  const [popularItems, setPopularItems] = useState<MenuItem[]>([]);
  const [categorySuggestedOrder, setCategorySuggestedOrder] = useState<number[]>([]);
  const [comboDefinitions, setComboDefinitions] = useState<ComboDefinition[]>([]);
  const [templates, setTemplates] = useState<OrderTemplate[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [posBrands, setPosBrands] = useState<VirtualBrand[]>([]);
  const [selectedBrand, setSelectedBrand] = useState<number | 'all'>('all');
  const [templateName, setTemplateName] = useState('');
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [showNavMenu, setShowNavMenu] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Pre-created order for terminal payments (MP Point)
  const [preCreatedOrderId, setPreCreatedOrderId] = useState<number | null>(null);

  // Conekta async payment results
  const [oxxoResult, setOxxoResult] = useState<{ reference: string; barcode_url: string; amount: number; expires_at: string } | null>(null);
  const [speiResult, setSpeiResult] = useState<{ clabe: string; bank: string; amount: number; expires_at: string } | null>(null);

  // Unpaid orders (for Cobrar flow)
  const [unpaidOrders, setUnpaidOrders] = useState<Order[]>([]);
  const [showUnpaidOrders, setShowUnpaidOrders] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState<Order | null>(null);
  const [showPaymentConfirmation, setShowPaymentConfirmation] = useState(false);

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
          (o) => o.status === 'ready' || o.status === 'completed' || o.source === 'qr_order'
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
        const [categoriesData, itemsData, modifierItemsData, popularData, categoryOrderData, combosData, templatesData, brandsData] = await Promise.all([
          getCachedCategories(),
          getCachedMenuItems(),
          getCachedItemsWithModifiers().catch(() => ({ itemIds: [] })),
          getCachedPopularItems(8).catch(() => []),
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
        setPopularItems(popularData);
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

  // ==================== Helpers ====================

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3000);
  };

  const generateCartId = () => `cart_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

  const filteredPopularItems = useMemo(() => {
    if (!brandItemMap) return popularItems;
    return popularItems.filter(item => brandItemMap.has(item.id));
  }, [popularItems, brandItemMap]);

  const total = parseFloat(
    cart.reduce((sum, item) => sum + item.unit_price * item.quantity, 0).toFixed(2)
  );
  const tax = parseFloat((total - total / (1 + TAX_RATE)).toFixed(2));
  const subtotal = parseFloat((total - tax).toFixed(2));
  const todayOrderCount = 1;

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
    setLinkedCustomer(null);
  };

  const buildOrderItems = () => cart.map((item) => ({
    menu_item_id: item.menu_item_id,
    quantity: item.quantity,
    notes: item.notes,
    modifiers: item.selectedModifierIds || [],
    combo_instance_id: item.combo_instance_id || null,
    virtual_brand_id: item.virtual_brand_id || null,
  }));

  const openPaymentModal = async () => {
    if ((isMpConnected || isConektaConfigured) && cart.length > 0) {
      try {
        const order = await createOrder({ employee_id: currentEmployee!.id, items: buildOrderItems() });
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

  const handleCardPayment = async (tip: number) => {
    if (cart.length === 0) { addToast(t('toast.cartEmpty'), 'error'); return; }
    setIsProcessingPayment(true);
    try {
      const order = await createOrder({ employee_id: currentEmployee!.id, items: buildOrderItems() });
      const paymentIntent = await createPaymentIntent({ order_id: order.id, tip });
      await confirmPayment({ order_id: order.id, payment_intent_id: paymentIntent.payment_intent_id });
      const finalOrder: Order = { ...order, tip, total: order.total + tip, payment_method: 'card', employee_name: currentEmployee?.name, estimated_ready_minutes: order.estimated_ready_minutes, estimated_ready_range: order.estimated_ready_range };
      await handleLoyaltyStamp(order);
      setCompletedOrder(finalOrder);
      setShowPaymentModal(false);
      setShowReceiptModal(true);
      clearCart();
      addToast(t('toast.cardDone'), 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toast.cardFailed'), 'error');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleCashPayment = async (tip: number, amountReceived: number) => {
    if (cart.length === 0) { addToast(t('toast.cartEmpty'), 'error'); return; }
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
        const order = await createOrder({ employee_id: currentEmployee!.id, items: buildOrderItems() });
        const result = await cashPayment({ order_id: order.id, tip, amount_received: amountReceived });
        const finalOrder: Order = { ...order, tip, total: order.total + tip, payment_method: 'cash', employee_name: currentEmployee?.name, estimated_ready_minutes: order.estimated_ready_minutes, estimated_ready_range: order.estimated_ready_range };
        await handleLoyaltyStamp(order);
        setCompletedOrder(finalOrder);
        setShowPaymentModal(false);
        setShowReceiptModal(true);
        clearCart();
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
      const orderId = preCreatedOrderId || (await createOrder({ employee_id: currentEmployee!.id, items: buildOrderItems() })).id;
      const result = await conektaOxxoPayment({ order_id: orderId, tip });
      setOxxoResult({
        reference: result.reference,
        barcode_url: result.barcode_url,
        amount: result.amount,
        expires_at: result.expires_at,
      });
      setShowPaymentModal(false);
      setPreCreatedOrderId(null);
      clearCart();
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
      const orderId = preCreatedOrderId || (await createOrder({ employee_id: currentEmployee!.id, items: buildOrderItems() })).id;
      const result = await conektaSpeiPayment({ order_id: orderId, tip });
      setSpeiResult({
        clabe: result.clabe,
        bank: result.bank,
        amount: result.amount,
        expires_at: result.expires_at,
      });
      setShowPaymentModal(false);
      setPreCreatedOrderId(null);
      clearCart();
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
      const orderId = preCreatedOrderId || (await createOrder({ employee_id: currentEmployee!.id, items: buildOrderItems() })).id;
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

  const handleSplitPayment = async (splits: Array<{ payment_method: 'card' | 'cash'; amount: number; tip: number }>) => {
    if (cart.length === 0) { addToast(t('toast.cartEmpty'), 'error'); return; }
    setIsProcessingPayment(true);
    try {
      const order = await createOrder({ employee_id: currentEmployee!.id, items: buildOrderItems() });
      await splitPayment({ order_id: order.id, split_type: 'by_amount', splits });
      const totalTip = splits.reduce((sum, s) => sum + s.tip, 0);
      const finalOrder: Order = { ...order, tip: totalTip, total: order.subtotal + order.tax + totalTip, payment_method: 'split', employee_name: currentEmployee?.name, estimated_ready_minutes: order.estimated_ready_minutes, estimated_ready_range: order.estimated_ready_range };
      await handleLoyaltyStamp(order);
      setCompletedOrder(finalOrder);
      setShowSplitPayment(false);
      setShowReceiptModal(true);
      clearCart();
      addToast(t('toast.splitDone'), 'success');
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toast.splitFailed'), 'error');
    } finally {
      setIsProcessingPayment(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const handleCobrar = async (order: Order) => {
    try {
      const fullOrder = await getOrder(order.id);
      setPaymentOrder(fullOrder);
      setShowPaymentConfirmation(true);
    } catch {
      addToast(t('toast.errorLoadingOrder'), 'error');
    }
  };

  const handlePaymentConfirmed = (method: 'cash' | 'card' | 'transfer') => {
    if (paymentOrder) {
      setUnpaidOrders((prev) => prev.filter((o) => o.id !== paymentOrder.id));
      const methodLabels: Record<string, string> = { cash: '\uD83D\uDCB5', card: '\uD83D\uDCB3', transfer: '\uD83D\uDCF2' };
      addToast(t('toast.orderPaid', { number: paymentOrder.order_number }), 'success');
    }
    setPaymentOrder(null);
    setShowPaymentConfirmation(false);
  };

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

        <AISuggestionBanner
          suggestions={cartSuggestions}
          onAccept={handleAcceptSuggestion}
          onDismiss={dismissSuggestion}
        />

        <MenuGrid
          filteredItems={filteredItems}
          filteredPopularItems={filteredPopularItems}
          brandItemMap={brandItemMap}
          itemModifierCache={itemModifierCache}
          soldOutItemIds={soldOutItemIds}
          pushItemIds={pushItemIds}
          avoidItemIds={avoidItemIds}
          lowStockItemIds={lowStockItemIds}
          searchQuery={searchQuery}
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
        onRemoveFromCart={removeFromCart}
        onUpdateQuantity={updateQuantity}
        onSetNotesItem={setNotesItem}
        onShowPaymentModal={openPaymentModal}
        onShowCustomerLookup={() => setShowCustomerLookup(true)}
        onShowTemplates={() => setShowTemplates(true)}
        onShowComboBuilder={() => setShowComboBuilder(true)}
        onShowSplitPayment={() => setShowSplitPayment(true)}
        onClearCart={clearCart}
        onLogout={handleLogout}
        onConvertToCombo={convertToCombo}
        onCobrar={handleCobrar}
        onToggleUnpaidOrders={() => setShowUnpaidOrders(!showUnpaidOrders)}
        onUnlinkCustomer={() => setLinkedCustomer(null)}
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
            onUnlinkCustomer={() => setLinkedCustomer(null)}
            onRemoveFromCart={removeFromCart}
            onUpdateQuantity={updateQuantity}
            onSetNotesItem={setNotesItem}
            onShowPaymentModal={openPaymentModal}
            onShowCustomerLookup={() => setShowCustomerLookup(true)}
            onShowTemplates={() => setShowTemplates(true)}
            onShowComboBuilder={() => setShowComboBuilder(true)}
            onShowSplitPayment={() => setShowSplitPayment(true)}
            onClearCart={clearCart}
            onLogout={handleLogout}
            comboSuggestion={comboSuggestion}
            onConvertToCombo={convertToCombo}
            total={total}
            subtotal={subtotal}
            tax={tax}
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
          orderTotal={total}
          items={cart}
          onSplitPayment={handleSplitPayment}
          onClose={() => setShowSplitPayment(false)}
          isProcessing={isProcessingPayment}
        />
      )}

      {showPaymentModal && (
        <PaymentModal
          orderTotal={total}
          orderId={preCreatedOrderId ?? undefined}
          onCardPayment={handleCardPayment}
          onCashPayment={handleCashPayment}
          onOxxoPayment={handleOxxoPayment}
          onSpeiPayment={handleSpeiPayment}
          onGetnetPayment={handleGetnetPayment}
          onTerminalPaymentSuccess={() => {
            clearCart();
            setShowPaymentModal(false);
            setPreCreatedOrderId(null);
            addToast(t('toast.mpConfirmed'), 'success');
          }}
          onCancel={() => { setShowPaymentModal(false); setPreCreatedOrderId(null); }}
          isProcessing={isProcessingPayment}
          isOnline={isOnline}
          conektaConfigured={isConektaConfigured}
          getnetEnabled={isGetnetEnabled}
        />
      )}

      {showReceiptModal && completedOrder && (
        <ReceiptModal
          order={completedOrder}
          onClose={() => { setShowReceiptModal(false); setCompletedOrder(null); }}
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
            addToast(t('toast.refundDone'), 'success');
          }}
        />
      )}

      {paymentOrder && (
        <PaymentConfirmationModal
          isOpen={showPaymentConfirmation}
          onClose={() => { setShowPaymentConfirmation(false); setPaymentOrder(null); }}
          order={paymentOrder}
          onPaymentConfirmed={handlePaymentConfirmed}
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
