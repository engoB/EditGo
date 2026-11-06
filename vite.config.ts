import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Deux sorties :
//  - par défaut : PWA hors ligne (service worker + manifeste), chemin relatif « ./ »
//    pour fonctionner aussi bien sur GitHub Pages que dans n'importe quel sous-dossier ;
//  - « --mode single » : un seul fichier HTML autonome (artefact testable, clé USB…).
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    define: { __SINGLE__: JSON.stringify(single), __BUILD__: JSON.stringify(new Date().toISOString()) },
    build: {
      outDir: single ? 'dist-single' : 'dist',
      target: 'es2022',
      assetsInlineLimit: single ? 100_000_000 : 4096,
      chunkSizeWarningLimit: 2000,
    },
    plugins: single
      ? [viteSingleFile()]
      : [
          VitePWA({
            injectRegister: null,
            registerType: 'autoUpdate',
            includeAssets: ['icon.svg', 'apple-touch-icon.png'],
            manifest: {
              name: 'EditGo — films souvenirs',
              short_name: 'EditGo',
              description: 'Films souvenirs automatiques, 100 % hors ligne, à partir de vos photos et vidéos.',
              lang: 'fr',
              theme_color: '#0d0d10',
              background_color: '#0d0d10',
              display: 'standalone',
              orientation: 'any',
              start_url: './',
              scope: './',
              icons: [
                { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
                { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
              ],
            },
            workbox: {
              globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
              maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
              navigateFallback: 'index.html',
            },
          }),
        ],
  };
});
