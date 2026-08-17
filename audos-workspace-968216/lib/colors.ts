/**
 * Genesis Space Design System
 * 
 * A cohesive color, typography, and component style system for the genesis space template.
 * All components should reference these constants for visual consistency.
 * 
 * IMPORTANT FOR APP BUILDERS:
 * When building apps, you MUST update the brand colors below to match the workspace branding.
 * Replace WORKSPACE_PRIMARY_COLOR and WORKSPACE_HIGHLIGHT_COLOR with actual brand hex values.
 * 
 * Color Philosophy:
 * - Brand: The main brand color used for primary actions (from workspace branding)
 * - Accent: Secondary brand color for highlights and agent elements (from workspace branding)
 * - Semantic: Green (success), Red (danger), Yellow (warning)
 * - Neutrals: Grays for backgrounds, text, and borders
 */

// =============================================================================
// CORE THEME CONFIGURATION - UPDATE THESE WITH WORKSPACE BRAND COLORS!
// =============================================================================

/**
 * Brand colors - These define the visual identity
 * IMPORTANT: Replace these hex values with the workspace brand colors:
 * - primary.600 should be WORKSPACE_PRIMARY_COLOR
 * - accent.600 should be WORKSPACE_HIGHLIGHT_COLOR (or primary if no distinct highlight)
 */
export const brand = {
  primary: {
    50: 'var(--space-brand-primary-50)',
    100: 'var(--space-brand-primary-100)',
    200: 'var(--space-brand-primary-200)',
    500: 'var(--space-brand-primary-500)',
    600: 'var(--space-brand-primary-600)',
    700: 'var(--space-brand-primary-700)',
    900: 'var(--space-brand-primary-900)',
  },
  accent: {
    50: 'var(--space-brand-highlight-50)',
    100: 'var(--space-brand-highlight-100)',
    200: 'var(--space-brand-highlight-200)',
    500: 'var(--space-brand-highlight-500)',
    600: 'var(--space-brand-highlight-600)',
    700: 'var(--space-brand-highlight-700)',
    900: 'var(--space-brand-highlight-900)',
  },
  contrast: 'var(--space-brand-contrast)',
} as const;

/**
 * Semantic colors - Use for status and feedback
 */
export const semantic = {
  success: {
    50: 'var(--space-semantic-success-100, color-mix(in srgb, var(--space-semantic-success) 12%, white))',
    100: 'var(--space-semantic-success-100, color-mix(in srgb, var(--space-semantic-success) 12%, white))',
    500: 'var(--space-semantic-success)',
    600: 'var(--space-semantic-success)',
    700: 'var(--space-semantic-success-700, var(--space-semantic-success))',
  },
  warning: {
    50: 'var(--space-semantic-warning-100, color-mix(in srgb, var(--space-semantic-warning) 12%, white))',
    100: 'var(--space-semantic-warning-100, color-mix(in srgb, var(--space-semantic-warning) 12%, white))',
    500: 'var(--space-semantic-warning)',
    600: 'var(--space-semantic-warning)',
    700: 'var(--space-semantic-warning-700, var(--space-semantic-warning))',
  },
  danger: {
    50: 'var(--space-semantic-danger-100, color-mix(in srgb, var(--space-semantic-danger) 12%, white))',
    100: 'var(--space-semantic-danger-100, color-mix(in srgb, var(--space-semantic-danger) 12%, white))',
    500: 'var(--space-semantic-danger-500, var(--space-semantic-danger))',
    600: 'var(--space-semantic-danger)',
    700: 'var(--space-semantic-danger-700, var(--space-semantic-danger))',
  },
} as const;

/**
 * Neutral colors - Backgrounds, text, borders
 */
export const neutral = {
  0: 'var(--space-neutral-0)',
  50: 'var(--space-neutral-50)',
  100: 'var(--space-neutral-100)',
  200: 'var(--space-neutral-200)',
  300: 'var(--space-neutral-300)',
  400: 'var(--space-neutral-400)',
  500: 'var(--space-neutral-500)',
  600: 'var(--space-neutral-600)',
  700: 'var(--space-neutral-700)',
  800: 'var(--space-neutral-800)',
  900: 'var(--space-neutral-900)',
  950: 'var(--space-neutral-950)',
} as const;

// =============================================================================
// TYPOGRAPHY SYSTEM
// =============================================================================

/**
 * Typography configuration
 * Font family is injected via Google Fonts in Desktop.tsx
 * IMPORTANT: Update the fontFamily to match workspace brand fonts from config.json!
 */
export const typography = {
  // Font family - loaded via Google Fonts link in Desktop.tsx
  // UPDATE: Replace "Inter" with the workspace headingFont from config.desktop.branding
  fontFamily: 'var(--space-font-family, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)',
  
  // Font sizes with line heights
  size: {
    xs: 'text-xs',      // 12px
    sm: 'text-sm',      // 14px
    base: 'text-base',  // 16px
    lg: 'text-lg',      // 18px
    xl: 'text-xl',      // 20px
    '2xl': 'text-2xl',  // 24px
    '3xl': 'text-3xl',  // 30px
    '4xl': 'text-4xl',  // 36px
  },
  
  // Font weights
  weight: {
    light: 'font-light',      // 300
    normal: 'font-normal',    // 400
    medium: 'font-medium',    // 500
    semibold: 'font-semibold', // 600
    bold: 'font-bold',        // 700
  },
  
  // Text colors
  // NOTE: All colors resolve from --space-* theme tokens (see theme.generated.ts)
  color: {
    primary: 'text-[var(--space-text-primary)]',      // Headings, important text
    secondary: 'text-[var(--space-text-secondary)]',  // Body text, descriptions
    tertiary: 'text-[var(--space-text-muted)]',       // Subtle text, captions
    muted: 'text-[var(--space-text-muted)]',          // Placeholder, disabled
    inverse: 'text-[var(--space-text-on-primary)]',   // On dark backgrounds
    brand: 'text-[var(--space-text-brand)]',
    accent: 'text-[var(--space-text-accent)]',
    danger: 'text-[var(--space-semantic-danger)]',    // Error text
    success: 'text-[var(--space-semantic-success-700)]', // Success text
  },
} as const;

// =============================================================================
// LEGACY COLORS OBJECT (for backwards compatibility)
// =============================================================================

export const colors = {
  primary: brand.primary,
  accent: brand.accent,
  success: semantic.success,
  warning: semantic.warning,
  danger: semantic.danger,
  neutral,
  
  // Gradient backgrounds (for Desktop background) — all recipes resolve from
  // the theme gradient tokens; restyling is a token swap, not a class edit.
  gradients: {
    default: 'from-[var(--space-surface-gradient-from)] via-[var(--space-surface-gradient-via)] to-[var(--space-surface-gradient-to)]',
    warm: 'from-[var(--space-surface-gradient-from)] via-[var(--space-surface-gradient-via)] to-[var(--space-surface-gradient-to)]',
    cool: 'from-[var(--space-surface-gradient-from)] via-[var(--space-surface-gradient-via)] to-[var(--space-surface-gradient-to)]',
    nature: 'from-[var(--space-surface-gradient-from)] via-[var(--space-surface-gradient-via)] to-[var(--space-surface-gradient-to)]',
    purple: 'from-[var(--space-surface-gradient-from)] via-[var(--space-surface-gradient-via)] to-[var(--space-surface-gradient-to)]',
  },
  
  // Glass/frosted effect
  glass: {
    background: 'bg-[var(--space-surface-panel)]/90 backdrop-blur-lg',
    border: 'border-[var(--space-border-default)]',
    shadow: 'shadow-[0_8px_32px_color-mix(in_srgb,var(--space-shell-shadow)_45%,transparent)]',
  }
} as const;

// =============================================================================
// TAILWIND CLASS HELPERS
// =============================================================================

/**
 * Tailwind class helpers for common UI patterns
 * Use these in your components for consistency
 */
export const tw = {
  // ---------------------------------------------------------------------------
  // BUTTONS
  // ---------------------------------------------------------------------------
  button: {
    // Primary action button (main CTA)
    primary: 'bg-[var(--space-brand-primary)] hover:bg-[var(--space-brand-primary-700)] text-[var(--space-text-on-primary)] font-medium shadow-[0_4px_14px_color-mix(in_srgb,var(--space-brand-primary)_35%,transparent)] transition-all',
    brand: 'bg-[var(--space-brand-primary)] hover:bg-[var(--space-brand-primary-700)] text-[var(--space-text-on-primary)] font-medium shadow-[0_4px_14px_color-mix(in_srgb,var(--space-brand-primary)_35%,transparent)] transition-all',
    accent: 'bg-[var(--space-brand-highlight)] hover:bg-[var(--space-brand-highlight-700)] text-[var(--space-text-on-highlight)] font-medium shadow-[0_4px_14px_color-mix(in_srgb,var(--space-brand-highlight)_35%,transparent)] transition-all',
    // Secondary button
    secondary: 'bg-[var(--space-surface-muted)] hover:brightness-95 text-[var(--space-text-primary)] font-medium transition-all',
    // Danger button
    danger: 'bg-[var(--space-semantic-danger)] hover:brightness-90 text-[var(--space-text-on-primary)] font-medium transition-all',
    // Ghost button (transparent)
    ghost: 'hover:bg-[var(--space-surface-muted)] text-[var(--space-text-secondary)] transition-all',
    // Disabled state modifier
    disabled: 'opacity-50 cursor-not-allowed',
  },
  
  // ---------------------------------------------------------------------------
  // FORM INPUTS
  // ---------------------------------------------------------------------------
  input: {
    // Base input styles
    base: 'w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:border-transparent transition-all',
    // Default state
    default: 'border-[var(--space-border-default)] bg-[var(--space-surface-card)] text-[var(--space-text-primary)] focus:ring-[var(--space-brand-primary)]',
    // Error state
    error: 'border-[var(--space-semantic-danger)] focus:ring-[var(--space-semantic-danger-500)]',
    // Disabled state
    disabled: 'bg-[var(--space-surface-muted)] text-[var(--space-text-muted)] cursor-not-allowed',
  },
  
  // ---------------------------------------------------------------------------
  // DOCK (left navigation)
  // ---------------------------------------------------------------------------
  dock: {
    active: 'bg-[var(--space-brand-primary)] text-[var(--space-text-on-primary)] shadow-[0_4px_16px_color-mix(in_srgb,var(--space-shell-shadow-strong)_55%,transparent)]',
    inactive: 'bg-[var(--space-surface-card)] hover:bg-[var(--space-surface-card-hover)] text-[var(--space-text-primary)]',
    glass: 'bg-[var(--space-surface-panel)]/85 backdrop-blur-lg rounded-2xl shadow-[0_8px_32px_color-mix(in_srgb,var(--space-shell-shadow)_50%,transparent)] border border-[var(--space-border-default)]',
  },
  
  // ---------------------------------------------------------------------------
  // MESSAGE BUBBLES (chat)
  // ---------------------------------------------------------------------------
  message: {
    user: 'bg-[var(--space-surface-accent-soft)] text-[var(--space-text-primary)]',
    assistant: 'bg-[var(--space-surface-panel)] text-[var(--space-text-primary)]',
  },
  
  // ---------------------------------------------------------------------------
  // ICONS - UPDATE accent with brand color (NOT purple)
  // ---------------------------------------------------------------------------
  icon: {
    primary: 'text-[var(--space-text-brand)]',
    accent: 'text-[var(--space-text-accent)]',
    neutral: 'text-[var(--space-text-secondary)]',
    muted: 'text-[var(--space-text-muted)]',
    danger: 'text-[var(--space-semantic-danger)]',
    success: 'text-[var(--space-semantic-success)]',
  },
  
  // ---------------------------------------------------------------------------
  // CARDS
  // ---------------------------------------------------------------------------
  card: {
    default: 'bg-[var(--space-surface-card)] border border-[var(--space-border-default)] rounded-lg shadow-[0_1px_4px_color-mix(in_srgb,var(--space-shell-shadow)_30%,transparent)] hover:shadow-[0_4px_14px_color-mix(in_srgb,var(--space-shell-shadow-strong)_40%,transparent)] transition-shadow',
    elevated: 'bg-[var(--space-surface-card)] rounded-2xl shadow-[0_12px_40px_color-mix(in_srgb,var(--space-shell-shadow-strong)_50%,transparent)] border border-[var(--space-border-default)]',
    glass: 'bg-[var(--space-surface-panel)]/85 backdrop-blur-md border border-[var(--space-border-default)] rounded-2xl shadow-[0_8px_32px_color-mix(in_srgb,var(--space-shell-shadow)_45%,transparent)]',
    flat: 'bg-[var(--space-surface-muted)] rounded-lg border border-[var(--space-border-default)]',
  },
  
  // ---------------------------------------------------------------------------
  // BADGES / PILLS - UPDATE accent with brand color (NOT purple)
  // ---------------------------------------------------------------------------
  badge: {
    default: 'px-2 py-0.5 text-xs font-medium rounded-full',
    primary: 'bg-[var(--space-surface-accent-soft)] text-[var(--space-text-brand)]',
    accent: 'bg-[var(--space-brand-highlight-100)] text-[var(--space-text-accent)]',
    success: 'bg-[var(--space-semantic-success-100)] text-[var(--space-semantic-success-700)]',
    warning: 'bg-[var(--space-semantic-warning-100)] text-[var(--space-semantic-warning-700)]',
    danger: 'bg-[var(--space-semantic-danger-100)] text-[var(--space-semantic-danger-700)]',
    neutral: 'bg-[var(--space-surface-muted)] text-[var(--space-text-secondary)]',
  },
  
  // ---------------------------------------------------------------------------
  // LAYOUTS
  // ---------------------------------------------------------------------------
  layout: {
    // Full-screen centered layout (for gates, modals)
    centerScreen: 'min-h-screen flex items-center justify-center',
    // Container with padding
    container: 'max-w-md w-full mx-auto p-8',
  },
  
  // ---------------------------------------------------------------------------
  // BACKGROUNDS & GRADIENTS - UPDATE accent with brand color (NOT purple)
  // ---------------------------------------------------------------------------
  bg: {
    page: 'bg-[linear-gradient(135deg,var(--space-surface-gradient-from),var(--space-surface-gradient-via),var(--space-surface-gradient-to))]',
    gate: 'bg-[linear-gradient(135deg,var(--space-surface-gradient-from),var(--space-surface-gradient-via),var(--space-surface-gradient-to))]',
    card: 'bg-[var(--space-surface-card)]',
    muted: 'bg-[var(--space-surface-muted)]',
    accent: 'bg-[var(--space-surface-accent-soft)]',
  },
  
  // ---------------------------------------------------------------------------
  // AGENT (AI Assistant styling) - UPDATE ALL with brand color (NOT purple!)
  // ---------------------------------------------------------------------------
  agent: {
    icon: 'text-[var(--space-shell-icon)]',
    fab: 'bg-[var(--space-brand-highlight)] hover:bg-[var(--space-brand-highlight-700)] text-[var(--space-text-on-highlight)] shadow-[0_6px_20px_color-mix(in_srgb,var(--space-brand-highlight)_40%,transparent)]',
    headerIcon: 'text-[var(--space-shell-icon)]',
    dockActive: 'bg-[var(--space-brand-highlight)] text-[var(--space-text-on-highlight)] shadow-[0_4px_14px_color-mix(in_srgb,var(--space-brand-highlight)_35%,transparent)]',
    dockInactive: 'bg-[var(--space-surface-muted)] text-[var(--space-text-primary)] hover:bg-[var(--space-surface-card-hover)]',
  },
  
  // ---------------------------------------------------------------------------
  // APP ICONS (mini app icon colors) - UPDATE active with brand color (NOT purple)
  // ---------------------------------------------------------------------------
  appIcon: {
    // Default app icon color
    default: 'text-[var(--space-text-brand)]',
    // Files/Memory icon
    files: 'text-[var(--space-text-brand)]',
    // Settings icon  
    settings: 'text-[var(--space-text-secondary)]',
    active: 'text-[var(--space-text-accent)]',
  },
  
  // ---------------------------------------------------------------------------
  // LEGACY (for backwards compatibility)
  // ---------------------------------------------------------------------------
  priority: {
    high: 'bg-[var(--space-semantic-danger-100)] text-[var(--space-semantic-danger-700)]',
    medium: 'bg-[var(--space-semantic-warning-100)] text-[var(--space-semantic-warning-700)]',
    low: 'bg-[var(--space-semantic-success-100)] text-[var(--space-semantic-success-700)]',
  },
  
  category: {
    work: 'bg-[var(--space-surface-accent-soft)] text-[var(--space-text-brand)]',
    ideas: 'bg-[var(--space-brand-highlight-100)] text-[var(--space-text-accent)]',
    personal: 'bg-[var(--space-semantic-success-100)] text-[var(--space-semantic-success-700)]',
    other: 'bg-[var(--space-surface-muted)] text-[var(--space-text-secondary)]',
  },

  typography,
} as const;

// =============================================================================
// COMPONENT-SPECIFIC STYLES
// =============================================================================

/**
 * EmailGate and authentication screen styles
 * Mobile-first responsive design with safe area support
 */
export const authStyles = {
  // Container - full screen centered with gradient, mobile-friendly padding
  container: `${tw.layout.centerScreen} ${tw.bg.gate} p-4 sm:p-8 safe-top safe-bottom`,
  // Card - elevated white card with responsive padding
  card: `${tw.card.elevated} p-6 sm:p-8 max-w-md w-full mx-4 sm:mx-auto`,
  // Title - responsive font size
  title: `text-xl sm:text-2xl ${typography.weight.semibold} ${typography.color.primary} text-center mb-2`,
  // Subtitle
  subtitle: `${typography.size.sm} ${typography.color.secondary} text-center`,
  // Input wrapper
  inputWrapper: 'space-y-4',
  // Input field - larger touch targets on mobile
  input: (hasError: boolean) => 
    `${tw.input.base} ${hasError ? tw.input.error : tw.input.default} text-base`,
  // Error message
  errorText: `mt-1.5 ${typography.size.xs} ${typography.color.danger}`,
  // Submit button - larger touch target on mobile
  submitButton: (disabled: boolean) =>
    `w-full px-4 py-3.5 sm:py-3 rounded-lg ${tw.button.primary} ${disabled ? tw.button.disabled : ''} text-base`,
  // Footer text
  footerText: `${typography.size.xs} ${typography.color.tertiary} text-center mt-4`,
} as const;

/**
 * Settings screen styles
 */
export const settingsStyles = {
  container: 'h-full overflow-y-auto',
  innerContainer: 'max-w-md mx-auto p-8',
  section: 'space-y-6',
  label: `block ${typography.size.sm} ${typography.weight.medium} ${typography.color.primary} mb-2`,
  input: (hasError: boolean) => 
    `${tw.input.base} ${hasError ? tw.input.error : tw.input.default}`,
  errorText: `mt-1.5 ${typography.size.xs} ${typography.color.danger}`,
  saveButton: (disabled: boolean) =>
    `w-full px-4 py-2.5 rounded-lg ${tw.button.primary} flex items-center justify-center gap-2 ${disabled ? tw.button.disabled : ''}`,
} as const;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get gradient class from config or return default
 */
export function getGradientClass(gradient?: string): string {
  return gradient || tw.bg.page;
}

/**
 * Get font family style object for inline styles
 */
export function getFontFamily(): React.CSSProperties {
  return { fontFamily: "var(--space-font-family, system-ui, sans-serif)" };
}

/**
 * Combine class names (simple utility)
 */
export function cn(...classes: (string | undefined | false)[]): string {
  return classes.filter(Boolean).join(' ');
}
