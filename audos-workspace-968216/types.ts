// Space types for TypeScript support

import type { BrandPalette } from "@shared/schema";

export interface AppConfig {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  component: string;
  dataFile?: string;
  // When true, the EmailGate is bypassed for direct deep-link access via ?app=<id>.
  // Used for tokenised entrypoints where the app component itself validates the token.
  public?: boolean;
}

export interface TerminologyConfig {
  reading?: string;
  writing?: string;
  creating?: string;
  deleting?: string;
  editing?: string;
}

export interface DesktopTheme {
  gradient: string;
  accentColor: string;
  dockStyle: string;
}

export interface DesktopThemeTokens {
  palette?: BrandPalette;
  typography?: {
    headingFont?: string;
    bodyFont?: string;
    fontFamily?: string;
  };
  shell?: {
    accentColor?: string;
    dockStyle?: string;
    pageBackground?: string;
    gateBackground?: string;
    panelBackground?: string;
    panelStrongBackground?: string;
  };
  cssVariables?: Record<string, string>;
}

export interface DesktopLayout {
  agentPosition: string;
  dockPosition: string;
  appWindowSize: string;
  // Papa Principle (app-vs-agent default face). 'app' → land on the fully
  // expanded app view (app home) with the agent one tap away; 'agent' or
  // absent → land in the conversation (v4 default).
  defaultLandingView?: 'agent' | 'app';
  // Which app is the "home" app when defaultLandingView === 'app'.
  // Defaults to the first app in config.apps.
  defaultLandingAppId?: string;
  // Legacy v3 flag (kept for cloned-config lineage; v4 ignores it in favor
  // of defaultLandingView).
  customerLandsOnAgent?: boolean;
}

export interface DesktopBranding {
  name: string;
  tagline?: string;
  logoUrl?: string;
  heroVideoUrl?: string;
  headingFont?: string;
  bodyFont?: string;
  colors?: Record<string, any>;
  palette?: Record<string, any>;
}

export interface DesktopConfig {
  theme: DesktopTheme;
  themeRecipe?: string;
  themeTokens?: DesktopThemeTokens;
  layout: DesktopLayout;
  branding: DesktopBranding;
}

export interface GenesisRuntimeTheme {
  branding: {
    name: string;
    tagline?: string;
    logoUrl?: string;
    heroVideoUrl?: string;
  };
  themeTokens: DesktopThemeTokens;
}

function buildFontFamily(fontName?: string): string {
  if (!fontName) {
    return '"Sora", system-ui, -apple-system, sans-serif';
  }

  return `"${fontName}", system-ui, -apple-system, sans-serif`;
}

export interface SpaceConfig {
  id: string;
  name: string;
  description?: string;
  version?: string;
  apps: AppConfig[];
  terminology?: TerminologyConfig;
  desktop: DesktopConfig;
}

export function resolveGenesisRuntimeTheme(
  config: SpaceConfig,
): GenesisRuntimeTheme {
  const branding = (config.desktop?.branding || {}) as DesktopBranding;
  const themeTokens = (config.desktop?.themeTokens || {}) as DesktopThemeTokens;
  const headingFont =
    themeTokens.typography?.headingFont ||
    branding.headingFont ||
    "Sora";
  const bodyFont =
    themeTokens.typography?.bodyFont ||
    branding.bodyFont ||
    headingFont;
  const shellTheme = {
    ...themeTokens.shell,
    accentColor: themeTokens.shell?.accentColor || config.desktop?.theme?.accentColor,
    dockStyle: themeTokens.shell?.dockStyle || config.desktop?.theme?.dockStyle,
  };

  return {
    branding: {
      name: branding.name || config.name || "Welcome",
      tagline: branding.tagline,
      logoUrl:
        branding.logoUrl ||
        (config as any).iconUrl ||
        (config as any).logoUrl,
      heroVideoUrl:
        branding.heroVideoUrl ||
        (config as any).heroVideoUrl ||
        (config as any).brandAssets?.heroVideoUrl,
    },
    themeTokens: {
      palette: themeTokens.palette || branding.palette || branding.colors,
      typography: {
        headingFont,
        bodyFont,
        fontFamily:
          themeTokens.typography?.fontFamily || buildFontFamily(headingFont),
      },
      shell: shellTheme,
      cssVariables: themeTokens.cssVariables || {},
    },
  };
}
