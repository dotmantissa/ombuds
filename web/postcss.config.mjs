/**
 * Tailwind v4 is a single PostCSS plugin. There is no tailwind.config.js in this project
 * on purpose: the theme is declared in CSS in app/globals.css via `@theme inline`.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
