// SPDX-License-Identifier: Apache-2.0
/** Brand images from `public/` (stable paths, not processed by Vite). */
export function BrandLogo() {
  // The logo is the page's level-one heading on the sign-in pages (its alt text names the app).
  return (
    <h1>
      <img src="/logo.png" srcSet="/logo-320.png 320w, /logo.png 640w" sizes="(min-width: 640px) 208px, 160px" width={640} height={659} alt="tavrn" className="mx-auto h-auto w-40 sm:w-52" data-testid="brand-logo" />
    </h1>
  );
}

export function BrandIcon({ size = 32 }: { size?: number }) {
  return <img src="/icon-64.png" width={size} height={size} alt="" aria-hidden="true" className="shrink-0 rounded-md" data-testid="brand-icon" />;
}
