import type {Config} from 'tailwindcss';
import tailwindAnimate from 'tailwindcss-animate';
import typography from '@tailwindcss/typography';

/**
 * Inlined from @sqlrooms/ui tailwind-preset to avoid needing
 * the fork's UI package at Tailwind config evaluation time.
 */
const preset: Partial<Config> = {
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'sqlrooms-progress': {
          '0%': {transform: 'translateX(0) scaleX(0)'},
          '40%': {transform: 'translateX(0) scaleX(0.4)'},
          '100%': {transform: 'translateX(100%) scaleX(0.5)'},
        },
      },
      animation: {
        'sqlrooms-progress': 'sqlrooms-progress 1s infinite linear',
      },
    },
  },
  plugins: [tailwindAnimate, typography],
};

const config = {
  ...preset,
  content: [
    'src/**/*.{ts,tsx}',
    './node_modules/@sqlrooms/*/dist/**/*.js',
  ],
  theme: {
    ...preset.theme,
    extend: {
      ...preset.theme?.extend,
    },
  },
} satisfies Config;

export default config;
