import type { Config } from "tailwindcss";
import tailwindAnimate from "tailwindcss-animate";

export default {
    darkMode: ["class"],
    content: ["src/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    theme: {
    	extend: {
    		fontFamily: {
    			// Inter was declared here but never loaded — no @font-face, no link
    			// tag — so every render already fell through to the platform UI
    			// face. Stating that honestly, with the CJK faces named explicitly
    			// so a Chinese answer picks the right one instead of a random
    			// installed fallback.
    			sans: [
    				'ui-sans-serif',
    				'system-ui',
    				'-apple-system',
    				'Segoe UI',
    				'PingFang SC',
    				'Hiragino Sans GB',
    				'Microsoft YaHei',
    				'sans-serif',
    				'Apple Color Emoji',
    				'Segoe UI Emoji',
    				'Segoe UI Symbol',
    				'Noto Color Emoji'
    			],
    			// Figures. SF Mono / Cascadia / JetBrains both carry a slashed zero
    			// and true tabular figures, which is what .fin-figure switches on.
    			mono: [
    				'ui-monospace',
    				'SF Mono',
    				'SFMono-Regular',
    				'Menlo',
    				'Cascadia Mono',
    				'JetBrains Mono',
    				'Consolas',
    				'monospace'
    			]
    		},
    		// Radius scales with the size of the thing it wraps, and nests:
    		// inner = outer − padding. See docs/2026-07-30-visual-design-language.md.
    		borderRadius: {
    			xs: 'var(--r-xs)',
    			sm: 'var(--r-sm)',
    			md: 'var(--r-md)',
    			lg: 'var(--r-lg)',
    			xl: 'var(--r-xl)',
    			'2xl': 'var(--r-2xl)'
    		},
    		// The elevation ladder. Components pick a level; no component may
    		// write its own shadow. Pair with `shadow-rim` for the top highlight.
    		boxShadow: {
    			e1: 'var(--e1)',
    			e2: 'var(--e2)',
    			e3: 'var(--e3)',
    			'e1-rim': 'var(--e1), inset 0 1px 0 var(--rim)',
    			'e2-rim': 'var(--e2), inset 0 1px 0 var(--rim)',
    			'e3-rim': 'var(--e3), inset 0 1px 0 var(--rim)'
    		},
            container: {
                center: true
            },
    		colors: {
    			// Design-language tokens. These carry their own alpha, so the
    			// `/N` opacity modifier does not apply to them by design —
    			// picking a level IS the way to pick a strength.
    			canvas: 'var(--canvas)',
    			surface: 'var(--surface)',
    			raised: 'var(--raised)',
    			label: {
    				1: 'var(--label-1)',
    				2: 'var(--label-2)',
    				3: 'var(--label-3)',
    				4: 'var(--label-4)'
    			},
    			fill: {
    				1: 'var(--fill-1)',
    				2: 'var(--fill-2)',
    				3: 'var(--fill-3)'
    			},
    			sep: {
    				DEFAULT: 'var(--sep)',
    				strong: 'var(--sep-strong)'
    			},
    			brand: {
    				DEFAULT: 'rgb(var(--brand-rgb) / <alpha-value>)',
    				sub: 'var(--brand-sub)'
    			},
    			up: 'rgb(var(--up-rgb) / <alpha-value>)',
    			down: 'rgb(var(--down-rgb) / <alpha-value>)',
    			hold: 'rgb(var(--hold-rgb) / <alpha-value>)',
    			background: 'hsl(var(--background))',
    			foreground: 'hsl(var(--foreground))',
    			card: {
    				DEFAULT: 'hsl(var(--card))',
    				foreground: 'hsl(var(--card-foreground))'
    			},
    			popover: {
    				DEFAULT: 'hsl(var(--popover))',
    				foreground: 'hsl(var(--popover-foreground))'
    			},
    			primary: {
    				DEFAULT: 'hsl(var(--primary))',
    				foreground: 'hsl(var(--primary-foreground))'
    			},
    			secondary: {
    				DEFAULT: 'hsl(var(--secondary))',
    				foreground: 'hsl(var(--secondary-foreground))'
    			},
    			muted: {
    				DEFAULT: 'hsl(var(--muted))',
    				foreground: 'hsl(var(--muted-foreground))'
    			},
    			accent: {
    				DEFAULT: 'hsl(var(--accent))',
    				foreground: 'hsl(var(--accent-foreground))'
    			},
    			destructive: {
    				DEFAULT: 'hsl(var(--destructive))',
    				foreground: 'hsl(var(--destructive-foreground))'
    			},
    			border: 'hsl(var(--border))',
    			input: 'hsl(var(--input))',
    			ring: 'hsl(var(--ring))',
    			chart: {
    				'1': 'hsl(var(--chart-1))',
    				'2': 'hsl(var(--chart-2))',
    				'3': 'hsl(var(--chart-3))',
    				'4': 'hsl(var(--chart-4))',
    				'5': 'hsl(var(--chart-5))'
    			},
    			sidebar: {
    				DEFAULT: 'hsl(var(--sidebar-background))',
    				foreground: 'hsl(var(--sidebar-foreground))',
    				primary: 'hsl(var(--sidebar-primary))',
    				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
    				accent: 'hsl(var(--sidebar-accent))',
    				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
    				border: 'hsl(var(--sidebar-border))',
    				ring: 'hsl(var(--sidebar-ring))'
    			}
    		}
    	}
    },
    plugins: [tailwindAnimate, require('@tailwindcss/typography')],
} satisfies Config;
