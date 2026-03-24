export interface Badge {
  type: string;
  label: string;
}

export interface MenuItemData {
  id: number;
  name: string;
  price: number;
  description?: string;
  imageUrl?: string | null;
  badges: Badge[];
}

export interface CategoryData {
  id: number;
  name: string;
  items: MenuItemData[];
}

export interface BrandTheme {
  primaryColor: string;
  secondaryColor?: string;
  fontFamily?: string;
  darkBg: string;
}

export interface BoardSettings {
  showCombos?: boolean;        // default true
  showLogo?: boolean;          // default true
  showClock?: boolean;         // default true
  showPrices?: boolean;        // default true
  showQrCode?: boolean;        // default false
  qrCodeUrl?: string;          // custom URL for QR code
  qrCodeLabel?: string;        // label under QR, e.g. "Scan to Order"
  slideDuration?: number;      // seconds per slide (default 12)
  footerText?: string;         // custom footer text (default "Precios en MXN")
  announcementText?: string;   // promo/announcement banner text
  showDescription?: boolean;   // show brand description (default true)
  qrRequirePayment?: boolean;  // require phone payment on QR orders (default false)
}

export interface BrandData {
  id: number;
  name: string;
  slug: string;
  description?: string;
  templateSlug?: string | null;
  boardSettings?: BoardSettings;
  theme: BrandTheme;
  categories: CategoryData[];
}

export interface TemplateViewProps {
  brand: BrandData;
  combos: any[];
  isPortrait: boolean;
  boardSettings?: BoardSettings;
}
