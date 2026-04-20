# Display Menu Spec

## Goal

Ship a customer-facing display menu in three phases using one shared menu source:

1. TV menu board
2. Checkout-facing customer display
3. Phone web menu

The first phase should feel like a digital version of a printed wall menu in a local shop:

- clean and understated
- text-first
- stable layout
- no fast-food energy
- menu visible most of the time
- small atmosphere layer for shop/neighborhood imagery and seasonal callouts

## Current Fit In This Repo

Relevant existing pieces:

- Menu data already exists in `menu_categories` and `menu_items`
- Branding already exists via `/api/branding` and `/api/branding/settings`
- Public customer menu already exists in `/api/customer-order/menu` and [src/screens/CustomerOrderScreen.tsx](/Users/juan/pos-lite/pos-lite/src/screens/CustomerOrderScreen.tsx:1)
- Display-oriented types already exist in [src/types/menu-board.ts](/Users/juan/pos-lite/pos-lite/src/types/menu-board.ts:1)
- Per-brand display settings already exist in `virtual_brands.board_settings`
- Virtual brand CRUD already exists in [server/routes/delivery-intelligence.js](/Users/juan/pos-lite/pos-lite/server/routes/delivery-intelligence.js:225)

Important gap:

- The frontend has `getMenuBoardData()` in [src/api/index.ts](/Users/juan/pos-lite/pos-lite/src/api/index.ts:1589), but there is no mounted `/api/menu-board` route in [server/index.js](/Users/juan/pos-lite/pos-lite/server/index.js:1)

Conclusion:

- Do not build a separate menu system
- Reuse regular menu tables as the source of truth
- Add a dedicated display presentation layer
- Keep display-specific content in a focused config structure

## Product Scope

### Phase 1: TV Menu Board

Single full-screen display for in-store viewing.

Primary jobs:

- communicate menu clearly
- reinforce local-shop brand feeling
- allow light seasonal updates without redesigning the screen

Non-goals for v1:

- interactive ordering
- promos-heavy carousels
- per-item photo cards
- complex scheduling

### Phase 2: Customer Checkout Display

Reuse the same menu data but change the presentation to:

- current order confirmation
- subtotal/totals
- subtle add-ons
- trust signals
- pickup or payment instructions if needed

### Phase 3: Phone Web Menu

Reuse the same categories/items/prices for a mobile menu:

- public browseable menu
- optional QR entry point
- optional ordering, depending on current customer-order flow

## UX Direction

### TV Layout

Permanent single-screen composition:

- left 68%: menu
- right 32%: atmosphere panel

Sections:

1. Top bar
- shop name
- optional short descriptor

2. Primary menu block
- `Burritos & Tacos`
- about 8 items
- name left, price right

3. Secondary menu block
- `Sides`
- `Drinks`
- drinks can visually separate `Beer` and `Soda`

4. Atmosphere panel
- one shop or neighborhood image
- one short line of copy max
- one seasonal or daily note

Motion rules:

- menu columns stay fixed
- only the right panel changes
- change interval: 20-40 seconds
- transition: fade only

Visual rules:

- warm neutral background
- dark text, not pure black
- one restrained accent color
- typography-led
- no app-style tiles
- no discount stickers
- no flashing promotions

## Technical Architecture

### Source of Truth

Keep these as canonical:

- `menu_categories`
- `menu_items`
- tenant branding from `/api/branding`

Do not duplicate menu item records for the TV.

### Display-Specific Content

Use a dedicated display config object instead of overloading generic branding fields.

Recommended shape:

```ts
type DisplayScreenType = 'tv' | 'customer_display' | 'web';

interface DisplayMenuSettings {
  version: 1;
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
    seasonalCallout?: {
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
```

### Where To Store It

Short-term recommendation:

- Add this JSON to tenant branding payload, for example `branding_json.displayMenu`

Why:

- phase 1 is a store-level display, not a delivery virtual brand
- the current `virtual_brands` table is oriented around delivery/menu-board hybrids
- this display is really a storefront presentation, not a separate brand

Alternative:

- reuse `virtual_brands.board_settings`

Why not preferred:

- the app seeds multiple virtual brands by default
- that introduces ambiguity around which brand owns the in-store TV
- the “local shop” TV should usually reflect the tenant’s main identity

Recommendation:

- keep the TV display attached to tenant branding
- keep `virtual_brands` for delivery-specific or multi-brand use cases

## Data Model Changes

### Minimal Required

1. Add item ordering support

Current issue:

- `/api/menu/items` sorts by `name ASC`
- TV layout needs explicit presentation order

Change:

- add `sort_order` to `menu_items`
- default to append order

DB:

```sql
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_menu_items_category_sort
  ON menu_items(category_id, sort_order, id);
```

API changes:

- `GET /api/menu/items` should order by `sort_order ASC, id ASC`
- create/update item endpoints should accept `sort_order`

2. Add display settings to branding

If stored in `branding_json`, no schema migration is needed beyond using the existing JSON payload.

3. Add display assets

Recommended new table:

```sql
CREATE TABLE IF NOT EXISTS display_assets (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT current_setting('app.tenant_id', true),
  kind TEXT NOT NULL, -- shop_photo | neighborhood_photo | seasonal_callout
  title TEXT,
  body TEXT,
  image_url TEXT,
  sort_order INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Why this table:

- avoids stuffing image rotation content into one JSON blob
- supports later reuse by TV and customer display
- makes seasonal scheduling straightforward

## API Plan

### 1. New TV Data Endpoint

Add a dedicated route:

- `GET /api/menu-board/data`

This should return a fully assembled payload for rendering the TV screen.

Response shape:

```ts
{
  shop: {
    name: string;
    tagline?: string;
    logoUrl?: string | null;
    primaryColor: string;
    address?: string;
  };
  layout: {
    template: 'local_shop_split';
    showPrices: boolean;
    showLogo: boolean;
    showTagline: boolean;
    footerText?: string;
    rotationSeconds: number;
  };
  categories: Array<{
    id: number;
    name: string;
    items: Array<{
      id: number;
      name: string;
      price: number;
      description?: string;
    }>;
  }>;
  atmosphere: {
    assets: Array<{
      id: string;
      kind: string;
      title?: string;
      body?: string;
      imageUrl?: string | null;
    }>;
    seasonalCallout?: {
      title?: string;
      body?: string;
    };
  };
}
```

Implementation notes:

- categories come from active `menu_categories`
- items come from active `menu_items`
- filter to configured category IDs if present
- order categories by `menu_categories.sort_order`
- order items by `menu_items.sort_order`
- include only active assets within schedule window

### 2. Display Settings Endpoints

Add:

- `GET /api/branding/display-menu`
- `PUT /api/branding/display-menu`

These should manage:

- phase toggles
- selected categories
- TV layout settings
- seasonal callout text

### 3. Display Assets Endpoints

Add:

- `GET /api/display-assets`
- `POST /api/display-assets`
- `PUT /api/display-assets/:id`
- `DELETE /api/display-assets/:id`

## Frontend Plan

### New Screen

Add:

- `src/screens/MenuBoardScreen.tsx`

Route:

- `/menu-board`

This should be public like `/order`.

### Rendering Behavior

MenuBoardScreen responsibilities:

- fetch `/api/menu-board/data`
- render fixed split layout
- rotate only the atmosphere panel
- auto-refresh every 60-120 seconds
- show a safe fallback if assets fail

Important:

- the menu should not paginate in v1
- if content overflows, fail loudly in admin preview rather than shrinking everything automatically

### New Admin Surface

Best fit:

- add a new admin screen at `/admin/display-menu`

Do not bury this under delivery.

This screen should provide:

1. TV settings
- enable TV menu
- choose visible categories
- toggle logo/tagline/prices
- edit footer text
- set rotation speed

2. Seasonal callout editor
- title
- body
- optional start/end dates

3. Atmosphere assets
- upload or select images
- mark active/inactive
- reorder assets

4. Preview
- embedded TV preview using the same renderer as `/menu-board`

### Existing Screen Changes

[src/screens/AdminDashboard.tsx](/Users/juan/pos-lite/pos-lite/src/screens/AdminDashboard.tsx:1)

- add a card for `Display Menu`

[src/App.tsx](/Users/juan/pos-lite/pos-lite/src/App.tsx:1)

- add `/menu-board`
- add `/admin/display-menu`

[src/screens/MenuManagement.tsx](/Users/juan/pos-lite/pos-lite/src/screens/MenuManagement.tsx:1)

- add item ordering controls
- optionally add a “show on display” affordance later, but not required for v1

## Admin Workflow

### V1 Owner Workflow

1. Open `Admin > Menu`
2. Set category order
3. Set item order inside each category
4. Open `Admin > Display Menu`
5. Choose categories for TV
6. Upload 2-5 atmosphere images
7. Edit seasonal note
8. Open TV preview
9. Put `/menu-board` on the in-store TV

Constraint:

- owner edits content, not layout code
- the template stays fixed

## Implementation Order

### Slice 1: Backend contract

1. Add `menu_items.sort_order`
2. Add `/api/menu-board/data`
3. Add display-menu settings read/write under branding
4. Add `display_assets` table and CRUD

### Slice 2: TV frontend

1. Add `MenuBoardScreen`
2. Add `/menu-board` route
3. Build fixed split layout
4. Add atmosphere rotation
5. Add reload/fallback handling

### Slice 3: Admin

1. Add `/admin/display-menu`
2. Add settings form
3. Add asset management
4. Add live preview

### Slice 4: Menu management cleanup

1. Add item ordering UI
2. Make category selection easier for display config
3. Validate long names in preview

## Acceptance Criteria

### TV v1

- a tenant can open `/menu-board` without auth
- the screen shows `Burritos & Tacos`, `Sides`, and `Drinks` in fixed positions
- prices are visible and aligned
- the atmosphere panel rotates without moving the menu
- the screen still looks good with no images configured
- the screen refreshes changed prices or callout text without a redeploy

### Admin v1

- a manager/admin can configure which categories appear
- a manager/admin can reorder items for display
- a manager/admin can upload and manage atmosphere assets
- a manager/admin can edit a seasonal callout
- preview matches production rendering

## Risks

1. Missing item sort order
- without this, the TV menu will look arbitrary

2. Overloading `virtual_brands`
- this will create confusion between delivery brands and storefront branding

3. Too much text in callouts
- the atmosphere panel must stay sparse

4. Long item names
- need truncation or admin validation rules

## Follow-On Work

After TV v1 is stable:

1. Build checkout-facing customer display using the same menu/settings source
2. Reuse the same categories/items/prices in a cleaned-up phone web menu
3. Add daypart variants only if the store actually needs them
4. Add QR support only after the passive screen is solid

## Recommendation

Build the TV menu board as a storefront presentation layer attached to tenant branding, not as a separate virtual brand product.

That gives the cleanest path:

- TV now
- checkout display next
- phone menu after that

All three can share the same menu data while keeping different presentation logic.
