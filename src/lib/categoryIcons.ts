// Emoji icon maps for menu categories and modifier groups
// Extracted from desktop-kitchen KioskScreen for mobile POS use

export const CATEGORY_ICON_MAP: Record<string, string> = {
  burrito: '🌯', burritos: '🌯',
  bebida: '🥤', bebidas: '🥤', drinks: '🥤', refresco: '🥤', refrescos: '🥤',
  coffee: '☕', café: '☕', cafe: '☕',
  comida: '🍽️', food: '🍽️', comer: '🍽️', platos: '🍽️', platillos: '🍽️',
  combo: '📦', combos: '📦', paquete: '📦', paquetes: '📦',
  postre: '🍰', postres: '🍰', dessert: '🍰', desserts: '🍰',
  snack: '🍿', snacks: '🍿', botana: '🍿', botanas: '🍿',
  desayuno: '🥞', breakfast: '🥞',
  ensalada: '🥗', ensaladas: '🥗', salad: '🥗', salads: '🥗',
  panadería: '🥐', panaderia: '🥐', bakery: '🥐', pan: '🥐',
  pizza: '🍕', pizzas: '🍕',
  hamburguesa: '🍔', hamburguesas: '🍔', burger: '🍔', burgers: '🍔',
  taco: '🌮', tacos: '🌮',
  sushi: '🍣',
  helado: '🍦', helados: '🍦', gelato: '🍦',
  jugo: '🧃', jugos: '🧃', juice: '🧃',
  alcohol: '🍺', cerveza: '🍺', beer: '🍺', cocktail: '🍸', coctel: '🍸',
  vino: '🍷', wine: '🍷',
  frappé: '🧋', frappe: '🧋', frappuccino: '🧋', smoothie: '🧋',
  té: '🍵', te: '🍵', tea: '🍵',
  hotdog: '🌭', 'hot dog': '🌭', 'hot dogs': '🌭',
  torta: '🥪', tortas: '🥪', sandwich: '🥪',
  agua: '💧', aguas: '💧', water: '💧',
};

export function getCategoryIcon(name: string): string {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(CATEGORY_ICON_MAP)) {
    if (lower.includes(key)) return icon;
  }
  return '🍽️';
}

export const MODIFIER_ICON_MAP: Record<string, string> = {
  size: '📏', tamaño: '📏', tamano: '📏',
  milk: '🥛', leche: '🥛',
  sugar: '🍬', azúcar: '🍬', azucar: '🍬', endulzante: '🍬',
  temperature: '🌡️', temperatura: '🌡️',
  topping: '🍫', toppings: '🍫',
  extra: '➕', extras: '➕',
  flavor: '🍓', sabor: '🍓',
  bread: '🍞', pan: '🍞',
  sauce: '🫙', salsa: '🫙',
  protein: '🥩', proteína: '🥩', proteina: '🥩',
  cheese: '🧀', queso: '🧀',
  drink: '🥤', bebida: '🥤',
  side: '🥗', guarnición: '🥗', guarnicion: '🥗',
  spice: '🌶️', picante: '🌶️',
};

export function getGroupIcon(name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, icon] of Object.entries(MODIFIER_ICON_MAP)) {
    if (lower.includes(key)) return icon;
  }
  return null;
}
