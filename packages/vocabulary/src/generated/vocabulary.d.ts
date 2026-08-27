// GENERATED FILE — do not edit.
// Source: sections.vocabulary.json · regenerate with `npm run build -w @underpin/vocabulary`

export type ArchetypeId =
  | "hero"
  | "text_media"
  | "feature_grid"
  | "testimonial"
  | "cta_band"
  | "faq"
  | "pricing_table"
  | "stats_strip"
  | "logo_wall"
  | "team_grid"
  | "contact_panel"
  | "content_list"
  | "product_card_grid"
  | "form"
  | "rich_text";

export interface ArchetypeVariants {
  "hero": {
    media?: "image" | "video" | "none";
    layout?: "full" | "split" | "minimal";
  };
  "text_media": {
    layout?: "img_left" | "img_right" | "text_only";
  };
  "feature_grid": {
    count?: number;
    iconStyle?: "icon" | "number" | "image" | "none";
  };
  "testimonial": {
    display?: "slider" | "grid" | "single";
  };
  "cta_band": {
    media?: "none" | "bg_image";
  };
  "faq": {
    display?: "accordion" | "list";
  };
  "pricing_table": {
    columns?: number;
  };
  "stats_strip": {
    layout?: "row" | "grid";
  };
  "logo_wall": {
    display?: "static" | "marquee";
  };
  "team_grid": {
    count?: number;
  };
  "contact_panel": {
    layout?: "form_map" | "form_only" | "map_only" | "details_only";
  };
  "content_list": {
    display?: "grid" | "list";
  };
  "product_card_grid": {
    count?: number;
    priceDisplay?: "show" | "hide" | "enquire";
  };
  "form": {
    layout?: "inline" | "panel";
  };
  "rich_text": Record<string, never>;
}

/** A section as it appears in the page IR, discriminated on `archetype`. */
export type Section = {
  [K in ArchetypeId]: {
    id: string;
    order: number;
    archetype: K;
    variant: ArchetypeVariants[K];
    confidence: number;
    decidedBy: 'builder_map' | 'rule' | 'llm' | 'human';
    slots: Record<string, unknown>;
    mediaRefs?: string[];
    style?: SectionStyle;
    sourceSelector?: string;
  };
}[ArchetypeId];

/** The seven computed properties we keep. Deliberately small — see docs/decisions.md #13. */
export interface SectionStyle {
  bgColor: string | null;
  bgImage: string | null;
  textColor: string | null;
  textAlign: 'left' | 'center' | 'right' | null;
  containerWidth: number | null;
  paddingBlock: { top: number; bottom: number } | null;
  isDark: boolean;
}

export interface Vocabulary {
  version: number;
  archetypes: Array<{
    id: ArchetypeId;
    label: string;
    component: string;
    variants?: Record<string, string[] | "int">;
    slots?: { required?: string[]; optional?: string[] };
    detect?: {
      position?: string;
      builderTypes?: string[];
      heuristics?: string[];
      jsonld?: string[];
      pluginMarkup?: string[];
      requiresCapability?: string;
    };
    carousel?: boolean;
    isFallback?: boolean;
  }>;
}
