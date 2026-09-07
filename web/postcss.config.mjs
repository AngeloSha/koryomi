// Tailwind v4 moved the PostCSS integration into its own package, and does its own vendor prefixing --
// so `autoprefixer` is gone rather than merely unused. Reintroduce the v3 `tailwindcss: {}` plugin here and
// the build fails outright with "trying to use tailwindcss directly as a PostCSS plugin".
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
