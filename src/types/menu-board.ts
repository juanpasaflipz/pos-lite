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
  sort_order?: number;
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

export interface DisplayMenuSettings {
  version: number;
  tv: {
    enabled: boolean;
    layout: 'local_shop_split';
    menuCategoryIds: number[];
    showPrices: boolean;
    showLogo: boolean;
    showTagline: boolean;
    footerText?: string;
    rotationSeconds: number;
    atmosphereMode: 'image_and_callout';
    activeAssetIds: string[];
    seasonalCallout: {
      title?: string;
      body?: string;
      startsAt?: string | null;
      endsAt?: string | null;
    };
  };
  customerDisplay: {
    enabled: boolean;
    suggestiveSellingEnabled: boolean;
  };
  web: {
    enabled: boolean;
    allowOrdering: boolean;
  };
}

export interface DisplayAsset {
  id: number;
  kind: 'shop_photo' | 'neighborhood_photo' | 'seasonal_callout';
  title?: string | null;
  body?: string | null;
  image_url?: string | null;
  sort_order: number;
  active: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  created_at?: string;
}

export interface MenuBoardDataResponse {
  shop: {
    name: string;
    tagline?: string;
    logoUrl?: string | null;
    primaryColor: string;
    address?: string;
  };
  layout: {
    template: 'local_shop_split';
    enabled: boolean;
    showPrices: boolean;
    showLogo: boolean;
    showTagline: boolean;
    footerText?: string;
    rotationSeconds: number;
  };
  categories: Array<{
    id: number;
    name: string;
    sort_order?: number;
    items: Array<{
      id: number;
      name: string;
      price: number;
      description?: string;
      sort_order?: number;
    }>;
  }>;
  atmosphere: {
    assets: Array<{
      id: string;
      kind: string;
      title?: string;
      body?: string;
      imageUrl?: string | null;
      sortOrder?: number;
    }>;
    seasonalCallout?: {
      title?: string;
      body?: string;
    } | null;
  };
}
